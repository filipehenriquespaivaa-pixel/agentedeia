import fs from 'fs';
import path from 'path';
import { exec } from 'child_process';
import https from 'https';
import http from 'http';
import zlib from 'zlib';
import { WORKSPACE } from './config.js';

// ============ CONFIRMAÇÃO DE COMANDOS ============
// executar_comando roda coisas no terminal do usuário — antes isso executava
// direto, sem confirmação real (apesar do prompt do sistema dizer que pedia).
// Agora a interface (index.js) registra aqui uma função que pergunta ao
// usuário sim/não antes de qualquer comando rodar de fato.
let confirmador = null;
export function setConfirmador(fn) {
  confirmador = fn;
}

// ============ MEMÓRIA PERSISTENTE ============
const MEMORY_FILE = path.join(process.cwd(), 'memoria.json');
const CATEGORIAS_VALIDAS = ['fatos', 'preferencias', 'projetos', 'notas'];
const MEMORY_PADRAO = { fatos: [], preferencias: {}, projetos: [], notas: [] };

// ============ INICIALIZAÇÃO AUTOMÁTICA ============
// Verifica e cria pasta de projetos e arquivo de memória se não existirem
function inicializarEstrutura() {
  const pastaProjetos = path.join(WORKSPACE, 'projetos_ia');
  
  // Criar pasta de projetos se não existir
  if (!fs.existsSync(pastaProjetos)) {
    try {
      fs.mkdirSync(pastaProjetos, { recursive: true });
      console.log(`✓ Pasta de projetos criada: ${pastaProjetos}`);
    } catch (e) {
      console.error(`✗ Erro ao criar pasta de projetos: ${e.message}`);
    }
  }
  
  // Criar arquivo de memória se não existir
  if (!fs.existsSync(MEMORY_FILE)) {
    try {
      saveMemory(structuredClone(MEMORY_PADRAO));
      console.log(`✓ Arquivo de memória criado: ${MEMORY_FILE}`);
    } catch (e) {
      console.error(`✗ Erro ao criar arquivo de memória: ${e.message}`);
    }
  }
}

// Executa a inicialização automaticamente ao importar o módulo
inicializarEstrutura();

function loadMemory() {
  if (!fs.existsSync(MEMORY_FILE)) return structuredClone(MEMORY_PADRAO);
  try {
    const dados = JSON.parse(fs.readFileSync(MEMORY_FILE, 'utf-8'));
    // Garante que todas as categorias existem, mesmo se o arquivo for antigo/incompleto
    return { ...structuredClone(MEMORY_PADRAO), ...dados };
  } catch (e) {
    // Arquivo corrompido: guarda uma cópia pra não perder o histórico e começa do zero
    try {
      fs.copyFileSync(MEMORY_FILE, MEMORY_FILE + '.corrompido-' + Date.now());
    } catch { /* se nem isso der, segue o baile */ }
    return structuredClone(MEMORY_PADRAO);
  }
}

function saveMemory(data) {
  try {
    fs.writeFileSync(MEMORY_FILE, JSON.stringify(data, null, 2), 'utf-8');
    return true;
  } catch (e) {
    return false;
  }
}

// Resumo compacto da memória pra injetar automaticamente no system prompt.
// Limita quantidade e tamanho de cada item pra não estourar o contexto
// (modelos pequenos costumam ter janelas de contexto curtas).
const MAX_ITENS_POR_CATEGORIA = 8;
const MAX_CHARS_POR_VALOR = 200;

export function resumoMemoria() {
  const memoria = loadMemory();
  const linhas = [];

  const truncar = (v) => {
    const s = typeof v === 'string' ? v : JSON.stringify(v);
    return s.length > MAX_CHARS_POR_VALOR ? s.substring(0, MAX_CHARS_POR_VALOR) + '…' : s;
  };

  const prefs = Object.entries(memoria.preferencias || {}).slice(-MAX_ITENS_POR_CATEGORIA);
  if (prefs.length) {
    linhas.push('Preferências: ' + prefs.map(([k, v]) => `${k}=${truncar(v)}`).join('; '));
  }

  for (const cat of ['fatos', 'projetos', 'notas']) {
    const itens = (memoria[cat] || []).slice(-MAX_ITENS_POR_CATEGORIA);
    if (itens.length) {
      linhas.push(`${cat[0].toUpperCase()}${cat.slice(1)}:\n` + itens.map(i => `  - ${i.chave}: ${truncar(i.valor)}`).join('\n'));
    }
  }

  return linhas.join('\n');
}

// ============ HTTP HELPER (sem dependências) ============
function httpGet(url, maxRedirects = 3) {
  return new Promise((resolve, reject) => {
    if (maxRedirects <= 0) return reject(new Error('Muitos redirects'));
    if (!/^https?:\/\//i.test(url)) return reject(new Error('URL precisa começar com http:// ou https://'));
    const client = url.startsWith('https') ? https : http;
    const req = client.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 AgenteIA/1.0',
        'Accept-Encoding': 'gzip, deflate, br'
      },
      timeout: 15000
    }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume(); // descarta o corpo da resposta de redirect
        return resolve(httpGet(res.headers.location, maxRedirects - 1));
      }

      // Antes não descomprimia nada — se o site mandasse gzip/br (a maioria
      // manda por padrão), a resposta virava lixo binário ilegível.
      const encoding = (res.headers['content-encoding'] || '').toLowerCase();
      let stream = res;
      if (encoding === 'gzip') stream = res.pipe(zlib.createGunzip());
      else if (encoding === 'deflate') stream = res.pipe(zlib.createInflate());
      else if (encoding === 'br') stream = res.pipe(zlib.createBrotliDecompress());

      const chunks = [];
      stream.on('data', chunk => chunks.push(chunk));
      stream.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
      stream.on('error', reject);
      res.on('error', reject);
    });
    req.on('timeout', () => req.destroy(new Error('Tempo esgotado (15s) esperando resposta')));
    req.on('error', reject);
  });
}

// ============ FERRAMENTAS ============

export const tools = [
  {
    type: 'function',
    function: {
      name: 'buscar_na_internet',
      description: 'Busca informações na internet. Use quando precisar de informações atuais ou dados online.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'O que buscar na internet' }
        },
        required: ['query']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'acessar_url',
      description: 'Acessa uma URL e retorna o conteúdo da página. Use para ler sites específicos.',
      parameters: {
        type: 'object',
        properties: {
          url: { type: 'string', description: 'URL completa (http:// ou https://)' }
        },
        required: ['url']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'criar_arquivo',
      description: 'Cria ou sobrescreve um arquivo com o conteúdo fornecido.',
      parameters: {
        type: 'object',
        properties: {
          caminho: { type: 'string', description: 'Caminho completo do arquivo (ex: d:\\ia local\\meu_arquivo.txt)' },
          conteudo: { type: 'string', description: 'Conteúdo do arquivo' }
        },
        required: ['caminho', 'conteudo']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'ler_arquivo',
      description: 'Lê o conteúdo de um arquivo existente.',
      parameters: {
        type: 'object',
        properties: {
          caminho: { type: 'string', description: 'Caminho completo do arquivo' }
        },
        required: ['caminho']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'editar_arquivo',
      description: 'Edita um arquivo existente substituindo um trecho exato de texto por outro, SEM reescrever o arquivo inteiro. Use isso em vez de criar_arquivo quando for uma mudança pontual em um arquivo grande — é mais rápido e evita reescrever (e arriscar corromper) o resto do arquivo. O texto em "busca" precisa aparecer EXATAMENTE (mesmos espaços/quebras de linha) e apenas UMA vez no arquivo; se não tiver certeza do conteúdo atual, use ler_arquivo antes.',
      parameters: {
        type: 'object',
        properties: {
          caminho: { type: 'string', description: 'Caminho completo do arquivo' },
          busca: { type: 'string', description: 'Trecho exato de texto a ser substituído (deve aparecer exatamente uma vez no arquivo)' },
          substituicao: { type: 'string', description: 'Texto que substitui o trecho encontrado (pode ser vazio, para apagar o trecho)' }
        },
        required: ['caminho', 'busca', 'substituicao']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'apagar_arquivo',
      description: 'Apaga um arquivo existente. Ação não pode ser desfeita — use com cuidado.',
      parameters: {
        type: 'object',
        properties: {
          caminho: { type: 'string', description: 'Caminho completo do arquivo a apagar' }
        },
        required: ['caminho']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'mover_arquivo',
      description: 'Move ou renomeia um arquivo ou pasta. Não sobrescreve se já existir algo no destino.',
      parameters: {
        type: 'object',
        properties: {
          origem: { type: 'string', description: 'Caminho atual do arquivo/pasta' },
          destino: { type: 'string', description: 'Novo caminho/nome' }
        },
        required: ['origem', 'destino']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'listar_diretorio',
      description: 'Lista arquivos e pastas em um diretório.',
      parameters: {
        type: 'object',
        properties: {
          caminho: { type: 'string', description: `Caminho do diretório (padrão: ${WORKSPACE})` }
        },
        required: []
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'criar_pasta',
      description: 'Cria uma nova pasta/diretório.',
      parameters: {
        type: 'object',
        properties: {
          caminho: { type: 'string', description: 'Caminho completo da pasta' }
        },
        required: ['caminho']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'executar_comando',
      description: 'Executa um comando no terminal PowerShell. O usuário vê o comando e precisa confirmar (s/N) antes dele rodar de verdade — não assuma que já foi aprovado.',
      parameters: {
        type: 'object',
        properties: {
          comando: { type: 'string', description: 'Comando PowerShell para executar' }
        },
        required: ['comando']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'abrir_programa',
      description: 'Abre um programa ou arquivo no computador do usuário.',
      parameters: {
        type: 'object',
        properties: {
          programa: { type: 'string', description: 'Nome do programa ou caminho do exe' },
          argumentos: { type: 'string', description: 'Argumentos opcionais' }
        },
        required: ['programa']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'salvar_memoria',
      description: 'Salva informação na memória persistente. Use para lembrar fatos, preferências ou notas.',
      parameters: {
        type: 'object',
        properties: {
          categoria: { type: 'string', enum: ['fatos', 'preferencias', 'projetos', 'notas'], description: 'Categoria' },
          chave: { type: 'string', description: 'Identificador da memória' },
          valor: { type: 'string', description: 'Conteúdo da memória' }
        },
        required: ['categoria', 'chave', 'valor']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'consultar_memoria',
      description: 'Consulta a memória persistente do agente.',
      parameters: {
        type: 'object',
        properties: {
          categoria: { type: 'string', enum: ['fatos', 'preferencias', 'projetos', 'notas', 'todas'], description: 'Categoria ou "todas"' }
        },
        required: []
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'criar_projeto',
      description: 'Cria APENAS a estrutura/esqueleto inicial de um projeto (pastas e arquivos vazios ou com um "hello world"). NÃO escreve lógica de jogo, app ou funcionalidade nenhuma. Se o usuário pediu algo funcional (um jogo, uma calculadora, um site específico), NÃO use esta ferramenta — escreva o código completo você mesmo e salve com criar_arquivo.',
      parameters: {
        type: 'object',
        properties: {
          nome: { type: 'string', description: 'Nome do projeto' },
          tipo: { type: 'string', enum: ['node', 'python', 'web', 'basico'], description: 'Tipo de projeto' },
          localizacao: { type: 'string', description: `Onde criar (padrão: ${WORKSPACE})` }
        },
        required: ['nome', 'tipo']
      }
    }
  }
];

// ============ EXECUTORES ============

// Argumentos obrigatórios de cada tool, pra validar antes de executar
const ARGS_OBRIGATORIOS = {
  buscar_na_internet: ['query'],
  acessar_url: ['url'],
  criar_arquivo: ['caminho', 'conteudo'],
  ler_arquivo: ['caminho'],
  // 'substituicao' fica de fora de propósito: pode ser uma string vazia
  // legítima (apagar um trecho), e a validação genérica trata '' como
  // "faltando".
  editar_arquivo: ['caminho', 'busca'],
  apagar_arquivo: ['caminho'],
  mover_arquivo: ['origem', 'destino'],
  criar_pasta: ['caminho'],
  executar_comando: ['comando'],
  abrir_programa: ['programa'],
  salvar_memoria: ['categoria', 'chave', 'valor'],
  criar_projeto: ['nome', 'tipo'],
};

export async function executeTool(name, args) {
  args = args || {};
  const obrigatorios = ARGS_OBRIGATORIOS[name];
  if (obrigatorios) {
    const faltando = obrigatorios.filter(campo => args[campo] === undefined || args[campo] === null || args[campo] === '');
    if (faltando.length > 0) {
      return `Erro: faltam os parâmetros obrigatórios (${faltando.join(', ')}) para ${name}.`;
    }
  }
  try {
    switch (name) {
      case 'buscar_na_internet': return await toolBuscar(args.query);
      case 'acessar_url': return await toolAcessarURL(args.url);
      case 'criar_arquivo': return toolCriarArquivo(args.caminho, args.conteudo);
      case 'ler_arquivo': return toolLerArquivo(args.caminho);
      case 'editar_arquivo': return toolEditarArquivo(args.caminho, args.busca, args.substituicao ?? '');
      case 'apagar_arquivo': return toolApagarArquivo(args.caminho);
      case 'mover_arquivo': return toolMoverArquivo(args.origem, args.destino);
      case 'listar_diretorio': return toolListarDiretorio(args.caminho || WORKSPACE);
      case 'criar_pasta': return toolCriarPasta(args.caminho);
      case 'executar_comando': return await toolExecutarComando(args.comando);
      case 'abrir_programa': return await toolAbrirPrograma(args.programa, args.argumentos);
      case 'salvar_memoria': return toolSalvarMemoria(args.categoria, args.chave, args.valor);
      case 'consultar_memoria': return toolConsultarMemoria(args.categoria);
      case 'criar_projeto': return await toolCriarProjeto(args.nome, args.tipo, args.localizacao);
      default: return `Ferramenta desconhecida: ${name}`;
    }
  } catch (error) {
    return `Erro ao executar ${name}: ${error.message}`;
  }
}

// ============ IMPLEMENTAÇÕES ============

async function toolBuscar(query) {
  // Usa DuckDuckGo HTML lite (sem JS necessário)
  const encoded = encodeURIComponent(query);
  const url = `https://html.duckduckgo.com/html/?q=${encoded}`;
  const html = await httpGet(url);
  
  // Parsear resultados do HTML
  const results = [];
  const regex = /<a rel="nofollow" class="result__a" href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?<a class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g;
  let match;
  while ((match = regex.exec(html)) !== null && results.length < 5) {
    const url = match[1].replace(/\/\/duckduckgo\.com\/l\/\?uddg=/, '').split('&')[0];
    const title = match[2].replace(/<[^>]+>/g, '').trim();
    const snippet = match[3].replace(/<[^>]+>/g, '').trim();
    if (title && !title.startsWith('http')) {
      results.push({ title, url: decodeURIComponent(url), snippet });
    }
  }

  if (results.length === 0) {
    // Fallback: tentar extrair links simples
    const linkRegex = /<a rel="nofollow" class="result__a" href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
    while ((match = linkRegex.exec(html)) !== null && results.length < 5) {
      const title = match[2].replace(/<[^>]+>/g, '').trim();
      if (title && title.length > 5) {
        results.push({ title, url: match[1], snippet: '' });
      }
    }
  }

  if (results.length === 0) return `Nenhum resultado encontrado para: "${query}"`;
  
  return results.map((r, i) => `${i + 1}. ${r.title}\n   URL: ${r.url}\n   ${r.snippet}\n`).join('\n');
}

async function toolAcessarURL(url) {
  const text = await httpGet(url);
  const limpo = text
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, ' ')
    .trim()
    .substring(0, 4000);
  return limpo || 'Página vazia ou sem conteúdo legível.';
}

function toolCriarArquivo(caminho, conteudo) {
  const dir = path.dirname(caminho);
  if (dir && !fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(caminho, conteudo, 'utf-8');
  return `Arquivo criado com sucesso: ${caminho}`;
}

function toolLerArquivo(caminho) {
  if (!fs.existsSync(caminho)) return `Arquivo não encontrado: ${caminho}`;
  const stat = fs.statSync(caminho);
  if (stat.isDirectory()) return `${caminho} é uma pasta, não um arquivo. Use listar_diretorio.`;
  const conteudo = fs.readFileSync(caminho, 'utf-8');
  if (conteudo.length > 4000) return conteudo.substring(0, 4000) + '\n... [conteúdo truncado]';
  return conteudo;
}

function toolEditarArquivo(caminho, busca, substituicao) {
  if (!fs.existsSync(caminho)) return `Arquivo não encontrado: ${caminho}`;
  const stat = fs.statSync(caminho);
  if (stat.isDirectory()) return `${caminho} é uma pasta, não um arquivo.`;
  if (!busca) return 'Erro: "busca" não pode ser vazio.';

  const conteudo = fs.readFileSync(caminho, 'utf-8');
  const partes = conteudo.split(busca);
  const ocorrencias = partes.length - 1;

  if (ocorrencias === 0) {
    return `Erro: o trecho de busca não foi encontrado em ${caminho}. Verifique se o texto está exatamente igual (espaços, quebras de linha, maiúsculas/minúsculas) — use ler_arquivo pra conferir o conteúdo atual antes de tentar de novo.`;
  }
  if (ocorrencias > 1) {
    return `Erro: o trecho de busca aparece ${ocorrencias} vezes em ${caminho}, mas precisa ser único. Inclua mais linhas de contexto ao redor pra tornar a busca específica a um único lugar.`;
  }

  const novoConteudo = partes.join(substituicao);
  fs.writeFileSync(caminho, novoConteudo, 'utf-8');
  return `Arquivo editado com sucesso: ${caminho} (${busca.length} caracteres substituídos por ${substituicao.length}).`;
}

function toolApagarArquivo(caminho) {
  if (!fs.existsSync(caminho)) return `Arquivo não encontrado: ${caminho}`;
  const stat = fs.statSync(caminho);
  if (stat.isDirectory()) return `${caminho} é uma pasta, não um arquivo. apagar_arquivo só apaga arquivos.`;
  fs.unlinkSync(caminho);
  return `Arquivo apagado: ${caminho}`;
}

function toolMoverArquivo(origem, destino) {
  if (!fs.existsSync(origem)) return `Não encontrado: ${origem}`;
  if (fs.existsSync(destino)) return `Já existe algo em ${destino} — escolha outro destino pra não sobrescrever nada por engano.`;
  const dir = path.dirname(destino);
  if (dir && !fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.renameSync(origem, destino);
  return `Movido: ${origem} → ${destino}`;
}

function toolListarDiretorio(caminho) {
  if (!fs.existsSync(caminho)) return `Diretório não encontrado: ${caminho}`;
  const stat = fs.statSync(caminho);
  if (!stat.isDirectory()) return `${caminho} é um arquivo, não uma pasta.`;
  const items = fs.readdirSync(caminho);
  if (items.length === 0) return `${caminho} está vazio.`;
  const detalhes = items.map(item => {
    try {
      const s = fs.statSync(path.join(caminho, item));
      return s.isDirectory() ? `[PASTA] ${item}` : `[ARQUIVO] ${item}`;
    } catch {
      return `[?] ${item} (sem permissão de leitura)`;
    }
  });
  return `Conteúdo de ${caminho}:\n${detalhes.join('\n')}`;
}

function toolCriarPasta(caminho) {
  if (fs.existsSync(caminho)) return `A pasta já existe: ${caminho}`;
  fs.mkdirSync(caminho, { recursive: true });
  return `Pasta criada com sucesso: ${caminho}`;
}

async function toolExecutarComando(comando) {
  // Antes disso o comando rodava direto, sem confirmação nenhuma — o prompt
  // do sistema dizia "pede confirmação do usuário" mas isso não existia de
  // fato no código. Agora, se a interface registrou um confirmador (ver
  // setConfirmador), o comando só roda se o usuário aprovar explicitamente.
  if (confirmador) {
    let aprovado;
    try {
      aprovado = await confirmador(comando);
    } catch {
      aprovado = false;
    }
    if (!aprovado) {
      return `Comando NÃO executado — o usuário não confirmou: ${comando}`;
    }
  }

  return new Promise((resolve) => {
    exec(comando, { timeout: 30000, maxBuffer: 1024 * 1024 }, (error, stdout, stderr) => {
      let resultado = '';
      if (stdout) resultado += `Saída:\n${stdout}\n`;
      if (stderr) resultado += `Avisos:\n${stderr}\n`;
      if (error) resultado += `Erro: ${error.message}`;
      resolve(resultado || 'Comando executado sem saída.');
    });
  });
}

async function toolAbrirPrograma(programa, argumentos) {
  return new Promise((resolve) => {
    const cmd = argumentos ? `start "" "${programa}" ${argumentos}` : `start "" "${programa}"`;
    exec(cmd, (error) => {
      if (error) resolve(`Erro ao abrir: ${error.message}`);
      else resolve(`Programa aberto: ${programa}`);
    });
  });
}

function toolSalvarMemoria(categoria, chave, valor) {
  if (!CATEGORIAS_VALIDAS.includes(categoria)) {
    return `Categoria inválida: "${categoria}". Use uma de: ${CATEGORIAS_VALIDAS.join(', ')}.`;
  }
  const memoria = loadMemory();
  if (categoria === 'preferencias') {
    memoria.preferencias[chave] = valor;
  } else {
    const existente = memoria[categoria].findIndex(item => item.chave === chave);
    if (existente >= 0) {
      memoria[categoria][existente].valor = valor;
    } else {
      memoria[categoria].push({ chave, valor, data: new Date().toISOString() });
    }
  }
  const ok = saveMemory(memoria);
  if (!ok) return `Não consegui salvar a memória em disco (verifique permissões de escrita em ${MEMORY_FILE}).`;
  return `Memória salva: [${categoria}] ${chave} = ${valor}`;
}

function toolConsultarMemoria(categoria) {
  const memoria = loadMemory();
  if (!categoria || categoria === 'todas') return JSON.stringify(memoria, null, 2);
  if (categoria === 'preferencias') return JSON.stringify(memoria.preferencias, null, 2);
  if (!CATEGORIAS_VALIDAS.includes(categoria)) {
    return `Categoria inválida: "${categoria}". Use uma de: ${CATEGORIAS_VALIDAS.join(', ')}, ou "todas".`;
  }
  return JSON.stringify(memoria[categoria] || [], null, 2);
}

async function toolCriarProjeto(nome, tipo, localizacao = WORKSPACE) {
  const projPath = path.join(localizacao, nome);
  const jaExistia = fs.existsSync(projPath) && fs.readdirSync(projPath).length > 0;
  fs.mkdirSync(projPath, { recursive: true });
  if (jaExistia) {
    return `Já existe uma pasta não-vazia em ${projPath}. Escolha outro nome ou apague a pasta antes, pra não sobrescrever nada por engano.`;
  }

  const templates = {
    node: {
      'package.json': JSON.stringify({ name: nome, version: '1.0.0', type: 'module', scripts: { start: 'node index.js' } }, null, 2),
      'index.js': `console.log('Olá do projeto ${nome}!');\n`
    },
    python: {
      'main.py': `# Projeto ${nome}\n\ndef main():\n    print("Olá do projeto ${nome}!")\n\nif __name__ == "__main__":\n    main()\n`,
      'requirements.txt': ''
    },
    web: {
      'index.html': `<!DOCTYPE html>\n<html lang="pt-BR">\n<head>\n  <meta charset="UTF-8">\n  <meta name="viewport" content="width=device-width, initial-scale=1.0">\n  <title>${nome}</title>\n  <link rel="stylesheet" href="style.css">\n</head>\n<body>\n  <h1>${nome}</h1>\n  <script src="script.js"></script>\n</body>\n</html>`,
      'style.css': `body { font-family: sans-serif; margin: 2rem; }\n`,
      'script.js': `console.log('Projeto ${nome} carregado!');\n`
    },
    basico: {
      'README.txt': `Projeto: ${nome}\nCriado em: ${new Date().toLocaleDateString('pt-BR')}\n`
    }
  };

  const arquivos = templates[tipo] || templates.basico;
  for (const [arquivo, conteudo] of Object.entries(arquivos)) {
    fs.writeFileSync(path.join(projPath, arquivo), conteudo, 'utf-8');
  }

  return `Projeto "${nome}" (${tipo}) criado em: ${projPath}\nArquivos: ${Object.keys(arquivos).join(', ')}\n\n` +
    `IMPORTANTE: estes são apenas arquivos de esqueleto/placeholder, sem nenhuma funcionalidade real. ` +
    `Se o pedido original era algo específico (um jogo, um app, uma página com conteúdo real), ` +
    `agora escreva o código completo de cada arquivo e sobrescreva-os com criar_arquivo.`;
}
