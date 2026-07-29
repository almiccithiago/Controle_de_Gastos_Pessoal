// ============================================================
// Meu Bolso em Dia — backend (Express + Turso/libSQL)
// Guarda o app inteiro como 1 JSON no banco (mais simples de manter
// sincronizado com o formato de dados do app HTML).
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

if (!process.env.TURSO_DATABASE_URL || !process.env.TURSO_AUTH_TOKEN) {
  console.error('ERRO: defina TURSO_DATABASE_URL e TURSO_AUTH_TOKEN nas variáveis de ambiente.');
  process.exit(1);
}

const db = createClient({
  url: process.env.TURSO_DATABASE_URL,
  authToken: process.env.TURSO_AUTH_TOKEN,
});

// ---------------------- Schema ----------------------
// Uma única tabela: guarda o "pacote" inteiro de dados do app como JSON,
// numa única linha (id = 1). Simples e suficiente para uso individual.
async function initSchema() {
  await db.execute(`
    CREATE TABLE IF NOT EXISTS app_state (
      id INTEGER PRIMARY KEY,
      data TEXT NOT NULL,
      updated_at TEXT DEFAULT (datetime('now'))
    )
  `);
}

// ---------------------- App ----------------------
const app = express();
app.use(cors());
app.use(express.json({ limit: '5mb' }));

// ---- Login simples ----
app.post('/api/login', (req, res) => {
  const { senha } = req.body;
  if (senha === APP_PASSWORD) return res.json({ ok: true });
  res.status(401).json({ ok: false, erro: 'Senha incorreta' });
});

// ---- Dados do app (o pacote inteiro em JSON) ----
app.get('/api/data', async (req, res) => {
  try {
    const result = await db.execute('SELECT data FROM app_state WHERE id = 1');
    if (result.rows.length === 0) {
      return res.json({ data: null });
    }
    res.json({ data: JSON.parse(result.rows[0].data) });
  } catch (e) {
    console.error('Erro ao ler dados:', e);
    res.status(500).json({ erro: 'Erro ao ler dados do banco.' });
  }
});

app.post('/api/data', async (req, res) => {
  try {
    const jsonStr = JSON.stringify(req.body);
    await db.execute({
      sql: `INSERT INTO app_state (id, data, updated_at) VALUES (1, ?, datetime('now'))
            ON CONFLICT(id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at`,
      args: [jsonStr],
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
      console.log(`Meu Bolso em Dia — backend rodando na porta ${PORT}`);
    });
  })
  .catch((err) => {
    console.error('Erro ao iniciar o schema do banco:', err);
    process.exit(1);
  });
