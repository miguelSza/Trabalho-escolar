'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const express = require('express');
const Database = require('better-sqlite3');

// ---------------------------------------------------------------------------
// Configuração (variáveis de ambiente)
// ---------------------------------------------------------------------------
const PORT = Number(process.env.PORT) || 3000;
const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'data', 'respostas.db');
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || ''; // vazio = rotas de admin desativadas

// ---------------------------------------------------------------------------
// Perguntas: fonte única da verdade (o frontend lê o mesmo arquivo)
// ---------------------------------------------------------------------------
const QUESTIONS = JSON.parse(
  fs.readFileSync(path.join(__dirname, 'public', 'questions.json'), 'utf8')
);

// ---------------------------------------------------------------------------
// Banco de dados
// ---------------------------------------------------------------------------
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.exec(`
  CREATE TABLE IF NOT EXISTS respostas (
    participante TEXT    NOT NULL,
    categoria    TEXT    NOT NULL,
    pergunta     INTEGER NOT NULL,
    opcao        INTEGER NOT NULL,
    outra        TEXT,
    criado_em    TEXT    NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (participante, categoria, pergunta)
  );
  CREATE INDEX IF NOT EXISTS idx_respostas_cat ON respostas (categoria, pergunta);
`);

const delStmt = db.prepare('DELETE FROM respostas WHERE participante = ? AND categoria = ?');
const insStmt = db.prepare(
  'INSERT INTO respostas (participante, categoria, pergunta, opcao, outra) VALUES (?, ?, ?, ?, ?)'
);
// Reenviar o mesmo questionário substitui as respostas anteriores (sem duplicar).
const salvar = db.transaction((pid, cat, respostas, outra) => {
  delStmt.run(pid, cat);
  const perguntas = QUESTIONS[cat].perguntas;
  respostas.forEach((opcao, i) => {
    const p = perguntas[i];
    const ehOutra = p.outra && opcao === p.opcoes.length - 1;
    insStmt.run(pid, cat, i, opcao, ehOutra && outra ? outra : null);
  });
});

const contagemStmt = db.prepare(
  'SELECT categoria, pergunta, opcao, COUNT(*) AS n FROM respostas GROUP BY categoria, pergunta, opcao'
);
const participantesStmt = db.prepare(
  'SELECT categoria, COUNT(DISTINCT participante) AS n FROM respostas GROUP BY categoria'
);

/** Contagens por categoria → pergunta → alternativa (zeros incluídos). */
function resultados() {
  const counts = {};
  const participantes = {};
  for (const [cat, c] of Object.entries(QUESTIONS)) {
    counts[cat] = c.perguntas.map((p) => p.opcoes.map(() => 0));
    participantes[cat] = 0;
  }
  for (const r of contagemStmt.all()) {
    const linha = counts[r.categoria] && counts[r.categoria][r.pergunta];
    if (linha && r.opcao < linha.length) linha[r.opcao] = r.n;
  }
  for (const r of participantesStmt.all()) {
    if (r.categoria in participantes) participantes[r.categoria] = r.n;
  }
  return { counts, participantes };
}

// ---------------------------------------------------------------------------
// Tempo real: Server-Sent Events
// ---------------------------------------------------------------------------
const clients = new Set();
let agendado = null;

function snapshot() {
  return JSON.stringify({ ...resultados(), online: clients.size });
}

/** Envia o estado atual a todos. Agrupa rajadas (ex.: turma inteira enviando junta). */
function broadcast() {
  if (agendado) return;
  agendado = setTimeout(() => {
    agendado = null;
    const msg = `event: dados\ndata: ${snapshot()}\n\n`;
    for (const res of clients) res.write(msg);
  }, 250);
}

setInterval(() => {
  for (const res of clients) res.write(': ping\n\n'); // mantém proxies de conexão abertos
}, 25000).unref();

// ---------------------------------------------------------------------------
// App HTTP
// ---------------------------------------------------------------------------
const app = express();
app.set('trust proxy', 1);
app.disable('x-powered-by');
app.use((req, res, next) => {
  res.set('X-Content-Type-Options', 'nosniff');
  next();
});
app.use(express.json({ limit: '10kb' }));
app.use(express.static(path.join(__dirname, 'public')));

app.get('/healthz', (req, res) => res.json({ ok: true }));

app.get('/api/resultados', (req, res) => {
  res.json({ ...resultados(), online: clients.size });
});

app.get('/api/stream', (req, res) => {
  res.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.flushHeaders();
  res.write('retry: 3000\n\n');
  clients.add(res);
  res.write(`event: dados\ndata: ${snapshot()}\n\n`);
  broadcast(); // atualiza o contador de "online" para os demais
  req.on('close', () => {
    clients.delete(res);
    broadcast();
  });
});

// Limite simples por participante (anti-spam acidental): 20 envios por minuto.
const envios = new Map();
function limitado(pid) {
  const agora = Date.now();
  const lista = (envios.get(pid) || []).filter((t) => agora - t < 60000);
  lista.push(agora);
  envios.set(pid, lista);
  return lista.length > 20;
}
setInterval(() => {
  const agora = Date.now();
  for (const [pid, lista] of envios) {
    if (!lista.some((t) => agora - t < 60000)) envios.delete(pid);
  }
}, 60000).unref();

app.post('/api/respostas', (req, res) => {
  const { participantId, categoria, respostas, outra } = req.body || {};

  if (typeof participantId !== 'string' || !/^[A-Za-z0-9-]{8,64}$/.test(participantId)) {
    return res.status(400).json({ erro: 'Identificador de participante inválido.' });
  }
  if (typeof categoria !== 'string' || !Object.hasOwn(QUESTIONS, categoria)) {
    return res.status(400).json({ erro: 'Categoria inválida.' });
  }
  const perguntas = QUESTIONS[categoria].perguntas;
  if (
    !Array.isArray(respostas) ||
    respostas.length !== perguntas.length ||
    !respostas.every((r, i) => Number.isInteger(r) && r >= 0 && r < perguntas[i].opcoes.length)
  ) {
    return res.status(400).json({ erro: 'Responda todas as perguntas com alternativas válidas.' });
  }
  if (limitado(participantId)) {
    return res.status(429).json({ erro: 'Muitos envios seguidos. Aguarde um instante.' });
  }

  const textoOutra = typeof outra === 'string' ? outra.trim().slice(0, 200) : '';
  salvar(participantId, categoria, respostas, textoOutra);
  broadcast();
  res.json({ ok: true });
});

// ---------------------------------------------------------------------------
// Administração (opcional): exportar CSV e zerar respostas
// ---------------------------------------------------------------------------
function admin(req, res, next) {
  if (!ADMIN_TOKEN) return res.status(404).end();
  const recebido = String(req.get('x-admin-token') || req.query.token || '');
  const a = crypto.createHash('sha256').update(recebido).digest();
  const b = crypto.createHash('sha256').update(ADMIN_TOKEN).digest();
  if (!crypto.timingSafeEqual(a, b)) return res.status(401).json({ erro: 'Não autorizado.' });
  next();
}

// Evita "injeção de fórmula" ao abrir o CSV no Excel/Sheets (campo livre vem dos alunos).
function celulaCsv(valor) {
  let s = valor == null ? '' : String(valor);
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
  return `"${s.replace(/"/g, '""')}"`;
}

app.get('/api/admin/export.csv', admin, (req, res) => {
  const linhas = db
    .prepare(
      'SELECT participante, categoria, pergunta, opcao, outra, criado_em FROM respostas ORDER BY criado_em, participante, categoria, pergunta'
    )
    .all();
  const cab = ['participante', 'categoria', 'n_pergunta', 'pergunta', 'resposta', 'outra_qual', 'enviado_em_utc'];
  const corpo = linhas.map((r) => {
    const p = QUESTIONS[r.categoria] && QUESTIONS[r.categoria].perguntas[r.pergunta];
    return [
      r.participante,
      r.categoria,
      r.pergunta + 1,
      p ? p.texto : '',
      p ? p.opcoes[r.opcao] : '',
      r.outra,
      r.criado_em,
    ]
      .map(celulaCsv)
      .join(',');
  });
  res.set({
    'Content-Type': 'text/csv; charset=utf-8',
    'Content-Disposition': 'attachment; filename="respostas.csv"',
  });
  res.send('\uFEFF' + [cab.map(celulaCsv).join(','), ...corpo].join('\r\n'));
});

app.post('/api/admin/reset', admin, (req, res) => {
  const { changes } = db.prepare('DELETE FROM respostas').run();
  broadcast();
  res.json({ ok: true, removidas: changes });
});

// ---------------------------------------------------------------------------
// Erros
// ---------------------------------------------------------------------------
app.use((err, req, res, next) => {
  if (err.type === 'entity.parse.failed' || err.type === 'entity.too.large') {
    return res.status(400).json({ erro: 'Requisição inválida.' });
  }
  console.error(err);
  res.status(500).json({ erro: 'Erro interno do servidor.' });
});

const server = app.listen(PORT, () => {
  console.log(`Servidor no ar: http://localhost:${PORT}`);
  console.log(`Banco de dados: ${DB_PATH}`);
  if (!ADMIN_TOKEN) console.log('ADMIN_TOKEN não definido: rotas de administração desativadas.');
});

function encerrar() {
  for (const res of clients) res.end();
  server.close(() => {
    db.close();
    process.exit(0);
  });
  setTimeout(() => process.exit(0), 3000).unref();
}
process.on('SIGINT', encerrar);
process.on('SIGTERM', encerrar);
