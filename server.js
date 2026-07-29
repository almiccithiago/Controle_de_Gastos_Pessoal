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
}

// ---------------------- App ----------------------
const app = express();
app.use(cors());
app.use(express.json({ limit: '5mb' }));

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
