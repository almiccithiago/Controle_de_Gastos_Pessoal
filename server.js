// ============================================================
// Meu Bolso em Dia — backend (Express + Turso/libSQL)
// Pronto para rodar no Render. Banco de dados fica no Turso (grátis).
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
async function initSchema() {
  await db.batch([
    `CREATE TABLE IF NOT EXISTS meses (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      nome TEXT NOT NULL,
      ano INTEGER NOT NULL,
      ordem INTEGER NOT NULL,
      criado_em TEXT DEFAULT (datetime('now')),
      UNIQUE(nome, ano)
    )`,
    `CREATE TABLE IF NOT EXISTS categorias (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      nome TEXT NOT NULL UNIQUE,
      tipo TEXT NOT NULL CHECK(tipo IN ('receita','despesa')),
      ordem INTEGER NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS itens (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      mes_id INTEGER NOT NULL REFERENCES meses(id) ON DELETE CASCADE,
      categoria_id INTEGER NOT NULL REFERENCES categorias(id) ON DELETE CASCADE,
      descricao TEXT NOT NULL,
      valor REAL NOT NULL DEFAULT 0,
      pago INTEGER NOT NULL DEFAULT 0,
      ordem INTEGER NOT NULL DEFAULT 0
    )`,
    `CREATE INDEX IF NOT EXISTS idx_itens_mes ON itens(mes_id)`,
    `CREATE INDEX IF NOT EXISTS idx_itens_categoria ON itens(categoria_id)`,
  ], 'write');

  const countRes = await db.execute('SELECT COUNT(*) AS n FROM categorias');
  const count = Number(countRes.rows[0].n);

  if (count === 0) {
    const categoriasIniciais = [
      { nome: 'Recebimentos', tipo: 'receita' },
      { nome: 'Despesas da casa', tipo: 'despesa' },
      { nome: 'Alimentação', tipo: 'despesa' },
      { nome: 'Saúde e proteção', tipo: 'despesa' },
      { nome: 'Transporte', tipo: 'despesa' },
      { nome: 'Educação', tipo: 'despesa' },
      { nome: 'Lazer', tipo: 'despesa' },
      { nome: 'Assinaturas', tipo: 'despesa' },
      { nome: 'Vestuário', tipo: 'despesa' },
      { nome: 'Cuidados pessoais', tipo: 'despesa' },
      { nome: 'Dívidas e empréstimos', tipo: 'despesa' },
      { nome: 'Outros', tipo: 'despesa' },
    ];
    for (let i = 0; i < categoriasIniciais.length; i++) {
      const c = categoriasIniciais[i];
      await db.execute({
        sql: 'INSERT INTO categorias (nome, tipo, ordem) VALUES (?, ?, ?)',
        args: [c.nome, c.tipo, i],
      });
    }
    console.log('Categorias iniciais criadas.');
  }
}

// ---------------------- App ----------------------
const app = express();
app.use(cors());
app.use(express.json());

// ---- Login simples ----
app.post('/api/login', (req, res) => {
  const { senha } = req.body;
  if (senha === APP_PASSWORD) return res.json({ ok: true });
  res.status(401).json({ ok: false, erro: 'Senha incorreta' });
});

// ---- Categorias ----
app.get('/api/categorias', async (req, res) => {
  const result = await db.execute('SELECT * FROM categorias ORDER BY ordem');
  res.json(result.rows);
});

// ---- Meses ----
app.get('/api/meses', async (req, res) => {
  const result = await db.execute('SELECT * FROM meses ORDER BY ordem');
  res.json(result.rows);
});

app.post('/api/meses', async (req, res) => {
  const { nome, ano } = req.body;
  try {
    const ordemRes = await db.execute('SELECT COALESCE(MAX(ordem), -1) + 1 AS n FROM meses');
    const ordem = Number(ordemRes.rows[0].n);
    const info = await db.execute({
      sql: 'INSERT INTO meses (nome, ano, ordem) VALUES (?, ?, ?)',
      args: [nome, ano, ordem],
    });
    res.json({ id: Number(info.lastInsertRowid), nome, ano, ordem });
  } catch (e) {
    res.status(400).json({ erro: 'Esse mês já existe.' });
  }
});

app.put('/api/meses/:id', async (req, res) => {
  const { nome, ano } = req.body;
  await db.execute({
    sql: 'UPDATE meses SET nome = ?, ano = ? WHERE id = ?',
    args: [nome, ano, req.params.id],
  });
  res.json({ ok: true });
});

app.put('/api/meses/reordenar', async (req, res) => {
  const { ordemIds } = req.body; // array de ids na nova ordem
  const statements = ordemIds.map((id, i) => ({
    sql: 'UPDATE meses SET ordem = ? WHERE id = ?',
    args: [i, id],
  }));
  await db.batch(statements, 'write');
  res.json({ ok: true });
});

app.delete('/api/meses/:id', async (req, res) => {
  await db.execute({ sql: 'DELETE FROM meses WHERE id = ?', args: [req.params.id] });
  res.json({ ok: true });
});

// ---- Itens ----
app.get('/api/meses/:mesId/itens', async (req, res) => {
  const result = await db.execute({
    sql: 'SELECT * FROM itens WHERE mes_id = ? ORDER BY categoria_id, ordem',
    args: [req.params.mesId],
  });
  res.json(result.rows);
});

app.post('/api/itens', async (req, res) => {
  const { mes_id, categoria_id, descricao, valor } = req.body;
  const ordemRes = await db.execute({
    sql: 'SELECT COALESCE(MAX(ordem), -1) + 1 AS n FROM itens WHERE mes_id = ? AND categoria_id = ?',
    args: [mes_id, categoria_id],
  });
  const ordem = Number(ordemRes.rows[0].n);
  const info = await db.execute({
    sql: 'INSERT INTO itens (mes_id, categoria_id, descricao, valor, ordem) VALUES (?, ?, ?, ?, ?)',
    args: [mes_id, categoria_id, descricao, valor, ordem],
  });
  res.json({ id: Number(info.lastInsertRowid), mes_id, categoria_id, descricao, valor, pago: 0, ordem });
});

app.put('/api/itens/:id', async (req, res) => {
  const { descricao, valor, pago } = req.body;
  await db.execute({
    sql: 'UPDATE itens SET descricao = ?, valor = ?, pago = ? WHERE id = ?',
    args: [descricao, valor, pago ? 1 : 0, req.params.id],
  });
  res.json({ ok: true });
});

app.delete('/api/itens/:id', async (req, res) => {
  await db.execute({ sql: 'DELETE FROM itens WHERE id = ?', args: [req.params.id] });
  res.json({ ok: true });
});

// ---- Backup (exportar tudo em JSON) ----
app.get('/api/backup', async (req, res) => {
  const meses = (await db.execute('SELECT * FROM meses ORDER BY ordem')).rows;
  const categorias = (await db.execute('SELECT * FROM categorias ORDER BY ordem')).rows;
  const itens = (await db.execute('SELECT * FROM itens')).rows;
  res.json({ meses, categorias, itens, exportado_em: new Date().toISOString() });
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
