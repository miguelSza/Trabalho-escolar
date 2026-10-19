(() => {
  'use strict';

  const LETRAS = 'ABCDEFGHIJ';
  const CORES = ['#0f766e', '#f59e0b', '#6366f1', '#ef4444', '#06b6d4', '#84cc16', '#ec4899', '#64748b'];
  const STORE_KEY = 'questionario-socioeconomico:v1';
  const $ = (id) => document.getElementById(id);
  const soma = (v) => v.reduce((a, b) => a + b, 0);
  const plural = (n, s, p) => `${n} ${n === 1 ? s : p}`;

  let CATEGORIAS = null; // vem de /questions.json
  let dados = null;      // último estado recebido do servidor: { counts, participantes, online }
  let grafico = null;

  const estado = {
    participantId: null,
    cat: null,
    i: 0,
    resp: {},          // resp[categoria][indicePergunta] = indiceAlternativa
    outra: {},         // outra[categoria] = texto do campo "Outra. Qual?"
    concluidas: new Set(),
  };

  // ---------------------------------------------------------------------------
  // Persistência local (rascunho + identificador anônimo do participante)
  // ---------------------------------------------------------------------------
  function novoId() {
    if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
    const b = new Uint8Array(16);
    crypto.getRandomValues(b);
    return Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
  }

  function carregarLocal() {
    try {
      const s = JSON.parse(localStorage.getItem(STORE_KEY) || 'null');
      if (s && typeof s.participantId === 'string') {
        estado.participantId = s.participantId;
        estado.resp = s.resp || {};
        estado.outra = s.outra || {};
        estado.concluidas = new Set(s.concluidas || []);
      }
    } catch (_) { /* armazenamento indisponível: segue sem rascunho */ }
    if (!estado.participantId) estado.participantId = novoId();
    Object.keys(CATEGORIAS).forEach((c) => { estado.resp[c] = estado.resp[c] || {}; });
    // descarta categorias salvas que não existem mais
    estado.concluidas = new Set([...estado.concluidas].filter((c) => c in CATEGORIAS));
  }

  function salvarLocal() {
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify({
        participantId: estado.participantId,
        resp: estado.resp,
        outra: estado.outra,
        concluidas: [...estado.concluidas],
      }));
    } catch (_) { /* ignora */ }
  }

  // ---------------------------------------------------------------------------
  // Telas
  // ---------------------------------------------------------------------------
  function mostrar(tela) {
    ['home', 'quiz', 'fim'].forEach((t) => ($(t).hidden = t !== tela));
    window.scrollTo(0, 0);
  }
  const telaAtual = () => ['home', 'quiz', 'fim'].find((t) => !$(t).hidden);

  function montarHome() {
    const box = $('cards');
    box.innerHTML = '';
    Object.entries(CATEGORIAS).forEach(([chave, c]) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'cat';
      b.innerHTML = `<div class="ic"></div><h2></h2><p></p><span class="cnt"></span>` +
        (estado.concluidas.has(chave) ? `<span class="tag">Concluído</span>` : '');
      b.querySelector('.ic').textContent = c.icone;
      b.querySelector('h2').textContent = c.titulo;
      b.querySelector('p').textContent = c.desc;
      b.querySelector('.cnt').dataset.cat = chave;
      b.onclick = () => iniciar(chave);
      box.appendChild(b);
    });
    atualizarContadoresHome();
    mostrar('home');
  }

  function atualizarContadoresHome() {
    document.querySelectorAll('.cnt[data-cat]').forEach((el) => {
      const n = dados ? dados.participantes[el.dataset.cat] || 0 : 0;
      el.textContent = dados ? plural(n, 'participante', 'participantes') : '';
    });
  }

  function iniciar(cat) {
    estado.cat = cat;
    estado.i = 0;
    render();
    mostrar('quiz');
  }

  const perguntaAtual = () => CATEGORIAS[estado.cat].perguntas[estado.i];

  function render() {
    const c = CATEGORIAS[estado.cat];
    const p = perguntaAtual();
    const sel = estado.resp[estado.cat][estado.i];
    $('cat-titulo').textContent = 'Questionário ' + c.titulo;
    $('pergunta-num').textContent = `Pergunta ${estado.i + 1} de ${c.perguntas.length}`;
    $('barra').style.width = ((estado.i + 1) / c.perguntas.length) * 100 + '%';
    $('pergunta-texto').textContent = p.texto;
    $('erro').textContent = '';
    $('avancar').disabled = false;
    $('avancar').textContent = estado.i === c.perguntas.length - 1 ? 'Concluir' : 'Avançar';

    const lista = $('opcoes');
    lista.innerHTML = '';
    p.opcoes.forEach((txt, k) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'opcao' + (sel === k ? ' sel' : '');
      b.innerHTML = `<span class="letra"></span><span class="t"></span>`;
      b.querySelector('.letra').textContent = LETRAS[k];
      b.querySelector('.t').textContent = txt;
      b.onclick = () => {
        estado.resp[estado.cat][estado.i] = k;
        salvarLocal();
        render();
      };
      lista.appendChild(b);
    });

    // Campo opcional "Outra. Qual?"
    const mostrarCampo = p.outra && sel === p.opcoes.length - 1;
    $('outra-txt').hidden = !mostrarCampo;
    $('outra-txt').value = estado.outra[estado.cat] || '';

    desenharGrafico();
  }

  // ---------------------------------------------------------------------------
  // Gráfico (dados vêm do servidor e são atualizados em tempo real)
  // ---------------------------------------------------------------------------
  function contagens() {
    const v = dados && dados.counts[estado.cat] && dados.counts[estado.cat][estado.i];
    return v ? v.slice() : perguntaAtual().opcoes.map(() => 0);
  }

  function desenharGrafico() {
    const p = perguntaAtual();
    const v = contagens();
    const cores = p.opcoes.map((_, k) => CORES[k % CORES.length]);
    const rotulos = p.opcoes.map((t, k) => `${LETRAS[k]}) ${t}`);
    if (grafico) grafico.destroy();
    grafico = new Chart($('grafico'), {
      type: 'pie',
      data: { labels: rotulos, datasets: [{ data: v, backgroundColor: cores, borderColor: '#fff', borderWidth: 2 }] },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: { display: false },
          tooltip: {
            callbacks: {
              label: (ctx) => {
                const t = soma(ctx.dataset.data);
                return ` ${plural(ctx.parsed, 'pessoa', 'pessoas')} (${t ? Math.round((ctx.parsed / t) * 100) : 0}%)`;
              },
            },
          },
          datalabels: {
            color: '#fff',
            font: { weight: 'bold', size: 13 },
            display: (ctx) => {
              const t = soma(ctx.dataset.data);
              return t > 0 && ctx.dataset.data[ctx.dataIndex] / t >= 0.05;
            },
            formatter: (valor, ctx) => Math.round((valor / soma(ctx.dataset.data)) * 100) + '%',
          },
        },
      },
    });
    preencherPainel(v);
  }

  /** Chamado a cada atualização ao vivo: altera os dados sem recriar o gráfico. */
  function atualizarGrafico() {
    if (!grafico) return;
    const v = contagens();
    grafico.data.datasets[0].data = v;
    grafico.update();
    preencherPainel(v);
  }

  function preencherPainel(v) {
    const p = perguntaAtual();
    const total = soma(v);
    const cores = p.opcoes.map((_, k) => CORES[k % CORES.length]);

    $('vazio').hidden = total > 0;
    $('sub').textContent = `Resultados em tempo real · ${plural(total, 'resposta', 'respostas')}`;

    const leg = $('legenda');
    leg.innerHTML = '';
    p.opcoes.forEach((t, k) => {
      const li = document.createElement('li');
      li.innerHTML = `<span class="cor"></span><span class="txt"></span><span class="num"></span>`;
      li.querySelector('.cor').style.background = cores[k];
      li.querySelector('.txt').textContent = `${LETRAS[k]}) ${t}`;
      li.querySelector('.num').textContent =
        `${plural(v[k], 'pessoa', 'pessoas')} · ${total ? Math.round((v[k] / total) * 100) : 0}%`;
      leg.appendChild(li);
    });
    const rodape = document.createElement('li');
    rodape.innerHTML = `<span class="txt"><strong>Total</strong></span><span class="num"><strong></strong></span>`;
    rodape.querySelector('strong:last-child').textContent = plural(total, 'participante', 'participantes');
    leg.appendChild(rodape);
  }

  // ---------------------------------------------------------------------------
  // Conexão em tempo real (Server-Sent Events, reconecta sozinho)
  // ---------------------------------------------------------------------------
  function definirStatus(ligado) {
    const el = $('status');
    el.className = 'status ' + (ligado ? 'on' : 'off');
    const texto = ligado
      ? `Ao vivo · ${dados ? plural(dados.online, 'pessoa online', 'pessoas online') : ''}`
      : 'Reconectando…';
    el.querySelector('span').textContent = texto.replace(/ · $/, '');
  }

  function conectar() {
    const es = new EventSource('/api/stream');
    es.addEventListener('dados', (e) => {
      try { dados = JSON.parse(e.data); } catch (_) { return; }
      definirStatus(true);
      const tela = telaAtual();
      if (tela === 'quiz') atualizarGrafico();
      if (tela === 'home') atualizarContadoresHome();
    });
    es.onerror = () => definirStatus(false);
  }

  // ---------------------------------------------------------------------------
  // Navegação e envio
  // ---------------------------------------------------------------------------
  function avancar() {
    const c = CATEGORIAS[estado.cat];
    if (estado.resp[estado.cat][estado.i] === undefined) {
      $('erro').textContent = 'Selecione uma alternativa para continuar.';
      return;
    }
    if (estado.i < c.perguntas.length - 1) {
      estado.i++;
      render();
    } else {
      concluir();
    }
  }

  function voltar() {
    if (estado.i > 0) {
      estado.i--;
      render();
    } else {
      montarHome();
    }
  }

  async function concluir() {
    const c = CATEGORIAS[estado.cat];
    const respostas = c.perguntas.map((_, k) => estado.resp[estado.cat][k]);
    const btn = $('avancar');
    btn.disabled = true;
    btn.textContent = 'Enviando…';
    $('erro').textContent = '';

    try {
      const r = await fetch('/api/respostas', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          participantId: estado.participantId,
          categoria: estado.cat,
          respostas,
          outra: estado.outra[estado.cat] || '',
        }),
      });
      if (!r.ok) {
        const corpo = await r.json().catch(() => ({}));
        throw new Error(corpo.erro || 'Não foi possível enviar suas respostas.');
      }
    } catch (e) {
      $('erro').textContent = (e instanceof TypeError ? 'Sem conexão com o servidor.' : e.message) + ' Tente novamente.';
      btn.disabled = false;
      btn.textContent = 'Concluir';
      return;
    }

    estado.concluidas.add(estado.cat);
    salvarLocal();
    telaFim();
  }

  function telaFim() {
    const c = CATEGORIAS[estado.cat];
    const todas = estado.concluidas.size === Object.keys(CATEGORIAS).length;
    $('fim-titulo').textContent = todas
      ? 'Parabéns! Você concluiu todos os questionários.'
      : `Questionário ${c.titulo} concluído!`;
    $('fim-msg').textContent =
      'Obrigado por responder! Suas respostas (anônimas) foram enviadas e já aparecem nos gráficos de todos os participantes.';
    const acoes = $('fim-acoes');
    acoes.innerHTML = '';
    Object.entries(CATEGORIAS).forEach(([chave, cat]) => {
      if (!estado.concluidas.has(chave)) {
        const b = document.createElement('button');
        b.className = 'btn';
        b.textContent = 'Ir para ' + cat.titulo;
        b.onclick = () => iniciar(chave);
        acoes.appendChild(b);
      }
    });
    const rev = document.createElement('button');
    rev.className = 'btn sec';
    rev.textContent = 'Revisar respostas';
    rev.onclick = () => { estado.i = 0; render(); mostrar('quiz'); };
    const home = document.createElement('button');
    home.className = 'btn sec';
    home.textContent = 'Página inicial';
    home.onclick = montarHome;
    acoes.append(rev, home);
    mostrar('fim');
  }

  // ---------------------------------------------------------------------------
  // Início
  // ---------------------------------------------------------------------------
  async function iniciarApp() {
    try {
      const r = await fetch('/questions.json');
      if (!r.ok) throw new Error('HTTP ' + r.status);
      CATEGORIAS = await r.json();
    } catch (_) {
      $('home').innerHTML = '<p class="erro">Não foi possível carregar o questionário. Recarregue a página.</p>';
      return;
    }
    Chart.register(ChartDataLabels);
    carregarLocal();
    $('avancar').onclick = avancar;
    $('voltar').onclick = voltar;
    $('outra-txt').oninput = (e) => {
      estado.outra[estado.cat] = e.target.value;
      salvarLocal();
    };
    montarHome();
    conectar();
  }

  iniciarApp();
})();
