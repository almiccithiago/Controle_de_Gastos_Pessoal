// ============================================================
// Backend compartilhado (Express + Turso/libSQL)
// Guarda o "pacote" de dados de cada app como 1 JSON no banco,
// identificado por um app_id (ex: "bolso", "gastos").
//
// Variáveis de ambiente necessárias (configurar no Render):
//   TURSO_DATABASE_URL   -> ex: libsql://seu-banco-sua-org.turso.io
//   TURSO_AUTH_TOKEN     -> token gerado no Turso
//   APP_PASSWORD         -> senha do app (opcional, padrão abaixo)
//
// Rode localmente com: npm install && npm start
// ============================================================

const express = require('express');
const cors = require('cors');
const { createClient } = require('@libsql/client');

const APP_PASSWORD = process.env.APP_PASSWORD || '712035';
const PORT = process.env.PORT || 3001;

// Permite senha diferente por app via variável de ambiente PASSWORD_<APPID> (ex: PASSWORD_GASTOS).
// Se não existir, cai na senha genérica APP_PASSWORD.
function getPasswordForApp(appId) {
  const key = `PASSWORD_${String(appId || '').toUpperCase()}`;
  return process.env[key] || APP_PASSWORD;
}

function requirePassword(req, res, next) {
  const expected = getPasswordForApp(req.params.appId);
  const provided = req.header('x-app-password');
  if (provided !== expected) {
    return res.status(401).json({ erro: 'Senha inválida ou ausente.' });
  }
  next();
}

if (!process.env.TURSO_DATABASE_URL || !process.env.TURSO_AUTH_TOKEN) {
  console.error('ERRO: defina TURSO_DATABASE_URL e TURSO_AUTH_TOKEN nas variáveis de ambiente.');
  process.exit(1);
}

const db = createClient({
  url: process.env.TURSO_DATABASE_URL,
  authToken: process.env.TURSO_AUTH_TOKEN,
});

// ---------------------- Schema ----------------------
async function initSchema() {
  await db.execute(`
    CREATE TABLE IF NOT EXISTS app_state (
      id INTEGER PRIMARY KEY,
      data TEXT NOT NULL,
      updated_at TEXT DEFAULT (datetime('now'))
    )
  `);

  // Migração: bancos criados antes de existir múltiplos apps não tinham a coluna app_id.
  // Os dados antigos (só existia o Meu Bolso em Dia) passam a ficar sob app_id = 'bolso'.
  const cols = await db.execute("PRAGMA table_info(app_state)");
  const hasAppId = cols.rows.some((r) => r.name === 'app_id');
  if (!hasAppId) {
    await db.execute('ALTER TABLE app_state ADD COLUMN app_id TEXT');
    await db.execute("UPDATE app_state SET app_id = 'bolso' WHERE app_id IS NULL");
  }
  await db.execute('CREATE UNIQUE INDEX IF NOT EXISTS idx_app_state_app_id ON app_state(app_id)');

  // Histórico automático: guarda uma cópia do estado anterior a cada save.
  await db.execute(`
    CREATE TABLE IF NOT EXISTS app_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      app_id TEXT NOT NULL,
      data TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now'))
    )
  `);
  await db.execute('CREATE INDEX IF NOT EXISTS idx_app_history_app_id ON app_history(app_id, id)');
}

const MAX_HISTORICO_POR_APP = 20;

// ---------------------- App ----------------------
const app = express();
app.use(cors());
app.use(express.json({ limit: '5mb' }));

// ---- Rota de saúde (pra ferramentas de monitoramento tipo UptimeRobot) ----
app.get('/', (req, res) => {
  res.status(200).send('OK - Meu Bolso em Dia / Controle de Gastos Pessoal backend no ar.');
});

// ---- Login simples (mesma senha compartilhada entre apps, hoje não é usado pelos HTMLs) ----
app.post('/api/login', (req, res) => {
  const { senha } = req.body;
  if (senha === APP_PASSWORD) return res.json({ ok: true });
  res.status(401).json({ ok: false, erro: 'Senha incorreta' });
});

// ---- Dados de um app específico (identificado por :appId, ex: "bolso", "gastos") ----
app.get('/api/data/:appId', requirePassword, async (req, res) => {
  res.set('Cache-Control', 'no-store');
  try {
    const { appId } = req.params;
    const result = await db.execute({
      sql: 'SELECT data FROM app_state WHERE app_id = ?',
      args: [appId],
    });
    if (result.rows.length === 0) {
      return res.json({ data: null });
    }
    res.json({ data: JSON.parse(result.rows[0].data) });
  } catch (e) {
    console.error('Erro ao ler dados:', e);
    res.status(500).json({ erro: 'Erro ao ler dados do banco.' });
  }
});

app.post('/api/data/:appId', requirePassword, async (req, res) => {
  try {
    const { appId } = req.params;
    const jsonStr = JSON.stringify(req.body);

    // Antes de sobrescrever, guarda o estado atual (se existir) como snapshot de histórico.
    const atual = await db.execute({
      sql: 'SELECT data FROM app_state WHERE app_id = ?',
      args: [appId],
    });
    if (atual.rows.length > 0) {
      await db.execute({
        sql: 'INSERT INTO app_history (app_id, data) VALUES (?, ?)',
        args: [appId, atual.rows[0].data],
      });
      // Mantém só os últimos MAX_HISTORICO_POR_APP snapshots por app.
      await db.execute({
        sql: `DELETE FROM app_history WHERE app_id = ? AND id NOT IN (
                SELECT id FROM app_history WHERE app_id = ? ORDER BY id DESC LIMIT ?
              )`,
        args: [appId, appId, MAX_HISTORICO_POR_APP],
      });
    }

    await db.execute({
      sql: `INSERT INTO app_state (app_id, data, updated_at) VALUES (?, ?, datetime('now'))
            ON CONFLICT(app_id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at`,
      args: [appId, jsonStr],
    });
    res.json({ ok: true });
  } catch (e) {
    console.error('Erro ao salvar dados:', e);
    res.status(500).json({ erro: 'Erro ao salvar dados no banco.' });
  }
});

// ---- Histórico automático de versões ----
app.get('/api/history/:appId', requirePassword, async (req, res) => {
  res.set('Cache-Control', 'no-store');
  try {
    const { appId } = req.params;
    const result = await db.execute({
      sql: 'SELECT id, created_at FROM app_history WHERE app_id = ? ORDER BY id DESC LIMIT ?',
      args: [appId, MAX_HISTORICO_POR_APP],
    });
    res.json({ snapshots: result.rows });
  } catch (e) {
    console.error('Erro ao ler histórico:', e);
    res.status(500).json({ erro: 'Erro ao ler histórico.' });
  }
});

app.get('/api/history/:appId/:snapshotId', requirePassword, async (req, res) => {
  res.set('Cache-Control', 'no-store');
  try {
    const { appId, snapshotId } = req.params;
    const result = await db.execute({
      sql: 'SELECT data, created_at FROM app_history WHERE app_id = ? AND id = ?',
      args: [appId, snapshotId],
    });
    if (result.rows.length === 0) {
      return res.status(404).json({ erro: 'Snapshot não encontrado.' });
    }
    res.json({ data: JSON.parse(result.rows[0].data), created_at: result.rows[0].created_at });
  } catch (e) {
    console.error('Erro ao ler snapshot:', e);
    res.status(500).json({ erro: 'Erro ao ler snapshot.' });
  }
});

// ---- Resumo em texto gerado por IA (chama a API do Gemini, free tier) ----
// Recebe um payload compacto (categorias com variação vs média, saldo, metas)
// já calculado no front-end e pede pro modelo escrever uma leitura curta do
// mês em português, mais 1-3 tags de destaque. Exige a variável de ambiente
// GEMINI_API_KEY configurada no Render (gerada gratuitamente em
// aistudio.google.com/apikey — não precisa de cartão).
app.post('/api/resumo-ia/:appId', requirePassword, async (req, res) => {
  try {
    if (!process.env.GEMINI_API_KEY) {
      return res.status(500).json({ erro: 'GEMINI_API_KEY não configurada no servidor.' });
    }
    const prompt = `Você recebe dados de um mês de controle financeiro pessoal em JSON. Escreva um resumo curto (3 a 4 frases, português do Brasil, tom direto e sem jargão) comentando o que mais chamou atenção (categorias que subiram ou caíram muito vs a média, saldo do mês, progresso de metas de economia). Depois, gere no máximo 3 tags curtas (poucas palavras cada) destacando os pontos principais, cada uma com tipo "alta" (algo subiu/preocupante), "baixa" (algo caiu/bom sinal) ou "neutra" (informativo).

Responda SOMENTE com JSON válido, sem markdown, no formato:
{"texto": "...", "tags": [{"tipo": "alta", "texto": "..."}]}

Dados do mês:
${JSON.stringify(req.body)}`;

    const modelo = process.env.GEMINI_MODEL || 'gemini-3-flash-preview';
    const resp = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${modelo}:generateContent`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-goog-api-key': process.env.GEMINI_API_KEY,
        },
        body: JSON.stringify({
          contents: [{ role: 'user', parts: [{ text: prompt }] }],
        }),
      }
    );

    if (!resp.ok) {
      const errText = await resp.text();
      console.error('Erro na API do Gemini:', resp.status, errText);
      return res.status(502).json({ erro: 'Não foi possível gerar o resumo agora.' });
    }

    const data = await resp.json();
    const textoBruto = data.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!textoBruto) {
      console.error('Resposta inesperada do Gemini:', JSON.stringify(data));
      return res.status(502).json({ erro: 'Resposta inesperada do modelo.' });
    }

    const limpo = textoBruto.replace(/```json|```/g, '').trim();
    let parsed;
    try {
      parsed = JSON.parse(limpo);
    } catch (e) {
      console.error('Não foi possível interpretar o JSON do modelo:', limpo);
      return res.status(502).json({ erro: 'Resposta do modelo em formato inesperado.' });
    }

    res.json({ texto: parsed.texto || '', tags: Array.isArray(parsed.tags) ? parsed.tags : [] });
  } catch (e) {
    console.error('Erro ao gerar resumo IA:', e);
    res.status(500).json({ erro: 'Erro ao gerar o resumo.' });
  }
});

// ---------------------- Start ----------------------
initSchema()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`Backend rodando na porta ${PORT}`);
    });
  })
  .catch((err) => {
    console.error('Erro ao iniciar o schema do banco:', err);
    process.exit(1);
  });
