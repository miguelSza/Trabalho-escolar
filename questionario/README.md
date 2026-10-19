# Questionário Socioeconómico — colaborativo e em tempo real

Mesmo visual do projeto original, agora com **backend Node.js + base de dados SQLite**.
Os alunos respondem no próprio telemóvel/computador e os gráficos de todos atualizam
sozinhos sempre que alguém envia um questionário.

## Executar localmente

Requer Node.js 18 ou superior.

```bash
npm install
npm start
```

Abra http://localhost:3000.

## Partilhar o link com a turma

**1. Mesma rede Wi-Fi (mais simples, para uma aula presencial).**
Descubra o IP do seu computador (`ipconfig` no Windows, `ifconfig`/`ip a` no Mac/Linux) e
envie `http://SEU-IP:3000`. Pode ser preciso permitir o Node.js na firewall.

**2. Túnel temporário (alunos em qualquer rede, sem alojar nada).**
Com o programa a correr, use um túnel gratuito, por exemplo
`cloudflared tunnel --url http://localhost:3000` ou `ngrok http 3000`, e partilhe o endereço https gerado.
O link só funciona enquanto o seu computador e o túnel estiverem ligados.

**3. Alojamento online permanente.**
Qualquer serviço que execute Node.js serve (Railway, Render, Fly.io, um VPS, etc.).
Pontos de atenção:

- Comando de arranque: `npm start`. A porta vem da variável `PORT`, que estes serviços definem sozinhos.
- **A base de dados é um ficheiro** (`data/respostas.db`). Se o serviço usar disco efémero, os dados
  perdem-se a cada reinício/novo deploy. Use um volume/disco persistente e aponte para ele com
  `DB_PATH` (ex.: `DB_PATH=/dados/respostas.db`). Confirme as condições do plano gratuito do serviço escolhido.
- Defina `ADMIN_TOKEN` (ver abaixo) para poder exportar os dados.
- Exporte o CSV no fim da atividade, por precaução.

## Administração (opcional)

Defina uma senha longa na variável de ambiente `ADMIN_TOKEN`. Sem ela, estas rotas ficam desativadas.

```bash
# Exportar todas as respostas (abre no Excel/Sheets); também funciona no navegador:
#   https://SEU-SITE/api/admin/export.csv?token=SUA_SENHA
curl -o respostas.csv "https://SEU-SITE/api/admin/export.csv?token=SUA_SENHA"

# Apagar todas as respostas (ex.: depois de testar, antes da turma responder)
curl -X POST -H "x-admin-token: SUA_SENHA" https://SEU-SITE/api/admin/reset
```

Dica: depois de um reset, o seu navegador de teste ainda mostra "Concluído" (é guardado localmente).
Teste numa janela anónima para ter sempre um participante "novo".

## Como funciona

```
Navegador ──POST /api/respostas──▶ Express ──▶ SQLite (data/respostas.db)
    ▲                                  │
    └────── GET /api/stream (SSE) ◀────┘   envia as contagens atualizadas a todos
```

- **Enviar:** ao clicar em *Concluir*, as 10 respostas da categoria seguem numa única transação.
  Reenviar a mesma categoria (mesmo navegador) **substitui** as respostas anteriores, não duplica.
- **Tempo real:** cada navegador mantém uma ligação Server-Sent Events. Quando entra uma resposta,
  o servidor recalcula as contagens e envia-as a todos; o gráfico é atualizado sem recarregar.
  Rajadas de envios (a turma toda ao mesmo tempo) são agrupadas em intervalos de 250 ms.
- **Validação no servidor:** categoria, número de respostas e índice de cada alternativa são verificados
  contra `public/questions.json`. O campo livre "Outra. Qual?" é limitado a 200 caracteres e,
  no CSV, protegido contra injeção de fórmulas.
- **Anonimato:** cada navegador gera um identificador aleatório (guardado no `localStorage`).
  Não há nomes, e-mails nem contas.

## Estrutura

```
server.js              API, base de dados e tempo real
public/
  index.html           página (mesma estrutura do original)
  style.css            CSS original + poucos acréscimos
  app.js               lógica do questionário e dos gráficos
  questions.json       perguntas e alternativas (fonte única, usada por servidor e cliente)
  vendor/              Chart.js e chartjs-plugin-datalabels (extraídos do seu HTML)
data/                  base de dados SQLite (criada automaticamente)
```

## Editar perguntas

Edite `public/questions.json` e reinicie o servidor. **As respostas são guardadas pela posição**
(pergunta nº X, alternativa nº Y). Por isso, só altere perguntas/alternativas **antes** de recolher
respostas reais; mudar a ordem ou o conteúdo depois faria os dados antigos apontarem para o item errado.
Em caso de dúvida, exporte o CSV e use o reset.

## Limitações conhecidas

- Sem login: quem limpar os dados do navegador (ou usar outro) pode responder de novo e contar como
  outro participante. Para uma turma isto costuma bastar; para evitar abusos pode acrescentar-se um
  código de acesso partilhado na aula.
- Há um limite de 20 envios por minuto por participante, mas nada impede alguém de gerar identificadores novos de propósito.
- SQLite num único servidor aguenta com folga turmas e escolas inteiras; não foi pensado para vários servidores em paralelo.
