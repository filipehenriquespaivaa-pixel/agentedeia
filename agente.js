// ============================================================
// agente.js — núcleo do agente (usado só pelo index.js agora que
// a interface web foi removida).
// ============================================================
import path from 'path';
import fs from 'fs';
import os from 'os';
import { execSync } from 'child_process';
import { tools, executeTool, resumoMemoria } from './tools.js';
import { LM_STUDIO_URL, LM_STUDIO_BASE, MODEL, WORKSPACE, getHeaders } from './config.js';
import * as estado from './estado.js';

export { LM_STUDIO_URL, LM_STUDIO_BASE, MODEL, WORKSPACE, getHeaders };

// ============ SYSTEM PROMPT ============
// A memória é injetada automaticamente aqui, a cada chamada, em vez de
// depender do modelo lembrar de chamar consultar_memoria por conta própria
// (um modelo pequeno raramente faz isso sem ser instruído a cada turno).
export function buildSystemPrompt() {
  const memoria = resumoMemoria();
  const blocoMemoria = memoria
    ? `\n\nMEMÓRIA (o que você já sabe sobre o usuário e projetos anteriores — use isso, não pergunte de novo o que já está aqui):\n${memoria}`
    : '';

  return `Você é um agente de IA local chamado "Agente IA". Você tem ferramentas para ajudar o usuário.

Ferramentas:
- criar_arquivo(caminho, conteudo) - Cria arquivo ou reescreve ele inteiro
- editar_arquivo(caminho, busca, substituicao) - Substitui um trecho exato de um arquivo existente, sem reescrever tudo
- ler_arquivo(caminho) - Lê arquivo
- apagar_arquivo(caminho) - Apaga um arquivo
- mover_arquivo(origem, destino) - Move/renomeia arquivo ou pasta
- listar_diretorio(caminho) - Lista pasta
- criar_pasta(caminho) - Cria pasta
- buscar_na_internet(query) - Busca web
- acessar_url(url) - Lê site
- executar_comando(comando) - Executa PowerShell (o usuário precisa confirmar antes do comando rodar de verdade — não assuma aprovação)
- abrir_programa(programa) - Abre programa
- criar_projeto(nome, tipo) - Cria projeto (node/python/web)
- salvar_memoria(categoria, chave, valor) - Salva na memória
- consultar_memoria() - Lê memória
- limpar_memoria(modo, categoria?, chave?, dias?) - Limpa memória (modos: completa, categoria, item, projetos-antigos, notas-antigas, estatisticas)

⚠️ INSTRUÇÕES CRÍTICAS PARA GERAR CONTEÚDO (aplicam pra qualquer tarefa — texto, pesquisa, análise ou código; a lista abaixo é ilustrativa, não uma lista fechada de categorias):

1. TEXTO EM GERAL (história, pesquisa, resumo, artigo, relatório, explicação, tradução, o que for):
   - Escreva de forma COMPLETA, no tamanho adequado à tarefa — nunca um resumo apressado quando o pedido pede desenvolvimento de verdade
   - Estruture com começo, meio e fim (ou introdução/desenvolvimento/conclusão, o que fizer sentido pro tipo de texto)
   - NUNCA use placeholders tipo "[continuar depois]" nem encerre de repente sem desenvolver o que foi pedido
   - Pesquisas e análises devem se basear em algo concreto (o que foi lido ou encontrado), nunca em respostas genéricas que serviriam pra qualquer pergunta

2. CÓDIGO E SCRIPTS:
   - Escreva código FUNCIONAL e TESTÁVEL, nunca funções vazias ou "// implementar depois"
   - Inclua comentários explicativos nas partes não óbvias

3. ANÁLISE DE ARQUIVOS:
   - Ao analisar um arquivo (procurando bug, avaliando qualidade, resumindo conteúdo), aponte coisas ESPECÍFICAS daquele arquivo — não observações genéricas que serviriam pra qualquer arquivo do mesmo tipo

4. ARQUIVOS DE CONFIGURAÇÃO (JSON, YAML, .gitignore, .env):
   - Podem ser curtos, mas devem ser completos e úteis — nunca só um placeholder

Regras:
- Fale português brasileiro
- Use ferramentas quando necessário
- Workspace: ${WORKSPACE}
- PowerShell: use ; não &&
- IMPORTANTE: se o usuário pedir algo funcional (um jogo, uma calculadora, um site específico, um script que faz algo), você MESMO escreve o código completo (HTML/CSS/JS/Python/etc) e salva com criar_arquivo. NUNCA use criar_projeto pra esse tipo de pedido — ela só cria um esqueleto vazio sem nenhuma lógica, e não serve como substituto de escrever o código de verdade.
- Quando o usuário mencionar um CAMINHO COMPLETO (ex: "D:\pasta\arquivo.txt" ou "C:\Users\...\teste"), USE ESSE CAMINHO EXATO ao chamar criar_arquivo. Não invente outros locais e não ignore o caminho pedido.
- Prefira editar_arquivo a criar_arquivo quando for uma mudança pontual (uma função, uma linha, um trecho) em um arquivo que já existe e é grande — reescrever o arquivo inteiro pra uma mudança pequena desperdiça contexto e aumenta a chance de erro. Use criar_arquivo quando o arquivo for novo ou a mudança for extensa o bastante que vale reescrever tudo.
- Se editar_arquivo falhar dizendo que o trecho de busca não foi encontrado ou aparece mais de uma vez, use ler_arquivo pra conferir o conteúdo real antes de tentar de novo — não adivinhe.
- Se você fez um plano com uma lista de arquivos, crie/edite TODOS os arquivos listados antes de considerar a tarefa concluída.
- ANTES de começar um NOVO projeto, verifique se há informações antigas na memória que possam causar confusão. Se encontrar dados de projetos anteriores que não têm relação com o pedido atual, use limpar_memoria para remover essas informações antigas primeiro.
- Quando o usuário pedir para criar histórias, contos ou textos narrativos: NUNCA repita exemplos de histórias anteriores. Cada história deve ser ORIGINAL e única. Use a estrutura narrativa (início, meio, fim) mas crie personagens, enredo e situações novas.
- Depois de terminar um projeto/arquivo importante, salve um resumo curto em salvar_memoria (categoria "projetos") com o que foi feito — isso vira contexto automático nas próximas conversas.${blocoMemoria}`;
}

// ============ CHAMADA AO LLM ============
export async function chamarLLM(messages, opcoes = {}) {
  const toolChoice = opcoes.toolChoice || 'auto';
  // maxTokens/temperature agora são configuráveis por chamada. Isso importa
  // principalmente pra geração de código (ver gerarConteudoArquivo): usar
  // uma temperatura mais baixa deixa modelos pequenos mais consistentes e
  // menos propensos a "esquecer" partes do arquivo no meio do caminho.
  const maxTokens = opcoes.maxTokens ?? -1;
  const temperature = opcoes.temperature ?? 0.7;
  let response;
  try {
    response = await fetch(LM_STUDIO_URL, {
      method: 'POST',
      headers: getHeaders(),
      body: JSON.stringify({ model: MODEL, messages, tools, tool_choice: toolChoice, temperature, max_tokens: maxTokens })
    });
  } catch (e) {
    throw new Error(`Não foi possível conectar ao LM Studio em ${LM_STUDIO_BASE}. Ele está aberto e com o servidor local ligado? (${e.message})`);
  }
  if (!response.ok) {
    let corpo = '';
    try { corpo = await response.text(); } catch { /* ignore */ }
    throw new Error(`LM Studio respondeu com erro ${response.status}. ${corpo.substring(0, 300)}`);
  }
  const data = await response.json();
  if (!data.choices || !data.choices[0]) {
    throw new Error('Resposta do LM Studio veio sem "choices" — verifique se o modelo carregado suporta tool calling.');
  }
  return data;
}

// ============ FALLBACK: tool calls escritas como JSON no texto ============
// Modelos locais pequenos às vezes "esquecem" o formato oficial de tool_calls
// e escrevem um JSON solto no meio da resposta. Isso detecta e recupera esses casos.
function detectarToolCallsNoTexto(texto) {
  const results = [];
  const jsonPattern = /\{[\s\S]*?"name"\s*:\s*"([^"]+)"[\s\S]*?"arguments"\s*:\s*(\{[\s\S]*?\})[\s\S]*?\}/g;
  let match;
  while ((match = jsonPattern.exec(texto)) !== null) {
    try {
      const name = match[1];
      const args = JSON.parse(match[2]);
      if (tools.some(t => t.function.name === name)) results.push({ name, arguments: args });
    } catch { /* JSON malformado, ignora esse trecho */ }
  }
  return results;
}

// ============ FASE DE PLANEJAMENTO ============
// Modelos pequenos tendem a partir direto pra ferramenta mais "óbvia" sem
// pensar na estrutura do que vão construir, e frequentemente esquecem de
// terminar tudo o que prometeram no plano. As melhorias aqui:
//
//  1. Detecção também cobre pedidos de EDIÇÃO/correção de algo que já existe
//     (antes só detectava "criar algo novo").
//  2. Se o usuário menciona um arquivo que já existe no workspace, o
//     conteúdo atual dele é lido e incluído ANTES do plano ser escrito —
//     assim o plano é baseado no código real, não em suposição.
//  3. O plano agora segue um formato fixo (lista de ARQUIVOS + LÓGICA), o
//     que permite extrair automaticamente quais arquivos foram prometidos
//     (e sua descrição/objetivo, usada depois pra gerar o conteúdo de cada
//     arquivo individualmente — ver GERAÇÃO DIRETA DE CADA ARQUIVO mais abaixo).
//  4. Depois que os arquivos são gerados, comparamos os arquivos prometidos
//     no plano com os que de fato foram criados. Se faltar algum, o agente
//     é cutucado pra terminar antes de responder — em vez de simplesmente
//     esquecer.

// Detecção de intenção baseada em CATEGORIAS ESTRUTURAIS (é um pedido de
// criar/editar/pesquisar/analisar algo?), não numa lista fechada de tópicos.
// Isso é o que faz o agente funcionar igual pra código, texto, pesquisa e
// análise de arquivo — em vez de precisar de uma palavra específica cadastrada
// pra cada assunto possível (o que nunca cobre tudo e trata alguns tipos de
// pedido como "cidadão de segunda classe").
const VERBOS_CONSTRUCAO = /\b(crie|criar|cria|construa|construir|desenvolva|desenvolver|fa[çc]a|fazer|monte|montar|programe|programar|quero|preciso|gostaria|implemente|implementar|escreva|escrever|redija|redigir|conte|contar|narre|narrar|descreva|descrever|pesquise|pesquisar|analise|analisar|investigue|investigar|compare|comparar|resuma|resumir|avalie|avaliar|explique|explicar|traduza|traduzir)\b/i;
const VERBOS_EDICAO = /\b(adicione|adicionar|mude|mudar|altere|alterar|corrija|corrigir|conserte|consertar|arrume|arrumar|melhore|melhorar|ajuste|ajustar|remova|remover|atualize|atualizar|refatore|refatorar|continue|continuar|troque|trocar|verifique|verificar)\b/i;

// Substantivos genéricos por CATEGORIA (artefato de código, conteúdo em texto,
// pesquisa/análise) em vez de uma lista fechada de gêneros específicos (ex:
// só "história, poesia, conto..."). A ideia é cobrir qualquer assunto dentro
// de cada categoria, não enumerar tópicos um por um.
const SUBSTANTIVOS_CONSTRUCAO = /\b(jogo|game|app|aplicativo|site|p[aá]gina|landing\s?page|sistema|script|programa|calculadora|to-?do|lista de tarefas|api|bot|chatbot|automa[çc][ãa]o|ferramenta|dashboard|painel|planilha|formul[aá]rio|extens[ãa]o|plugin|componente|fun[çc][ãa]o|m[oó]dulo|classe|endpoint|rota|projeto|arquivo|c[oó]digo|texto|conte[uú]do|documento|hist[oó]ria|artigo|resumo|relat[oó]rio|pesquisa|an[aá]lise|resposta|dados|material)\b/i;

// Extensões de arquivo comuns que o usuário pode citar pelo nome (ex: "conserte o jogo.html")
const REGEX_ARQUIVO_MENCIONADO = /\b[\w\-]+\.(html|htm|css|js|jsx|ts|tsx|json|py|txt|md|bat|ps1|sh|sql)\b/gi;

// Nova: evita disparar plano quando o usuário está NEGANDO a ação
// ("não crie", "não quero mais", "sem precisar programar")
const NEGACAO_PROXIMA_AO_VERBO = /\bn[ãa]o\s+(?:\w+\s+){0,2}(quero|precise|precisa|crie|criar|construa|fa[çc]a|desenvolva|monte|programe|implemente)\b/i;

// Nova: confirmações curtas ("sim", "pode", "ok", "manda ver") não devem
// re-disparar um plano do zero — normalmente é continuação do que já foi
// planejado na mensagem anterior.
const CONFIRMACAO_CURTA = /^\s*(sim|ok(?:ay)?|pode|pode ir|continue|continua|vai|manda|manda ver|show|isso a[íi]|perfeito|beleza|blz)[\s!.,]*$/i;

function extrairArquivosMencionados(msg) {
  const matches = msg.match(REGEX_ARQUIVO_MENCIONADO) || [];
  return [...new Set(matches.map(m => m.trim()))];
}

// Detecta um caminho absoluto do Windows mencionado na mensagem (ex: "na
// pasta D:\ia local\...\ARQUIVOS IA"). Path do Windows pode ter espaços nos
// nomes das pastas, então não dá pra cortar em espaço — em vez disso, captura
// até o fim da frase/mensagem e tira pontuação sobrando do final. É uma
// heurística (não cobre todo mundo), mas resolve o caso comum de "crie X na
// pasta Y" onde Y vem no fim da mensagem.
function extrairPastaOuArquivoAbsoluto(msg) {
  const m = msg.match(/[A-Za-z]:\\.+$/);
  if (!m) return null;
  return m[0].trim().replace(/[.,;:]+$/, '');
}

function isPedidoDeConstrucao(msg, arquivosMencionados) {
  if (CONFIRMACAO_CURTA.test(msg)) return false;
  if (NEGACAO_PROXIMA_AO_VERBO.test(msg)) return false;

  const temVerbo = VERBOS_CONSTRUCAO.test(msg) || VERBOS_EDICAO.test(msg);
  if (!temVerbo) return false;
  return SUBSTANTIVOS_CONSTRUCAO.test(msg) || arquivosMencionados.length > 0;
}

// Lê o conteúdo atual de arquivos que o usuário citou pelo nome, se existirem,
// pra o plano ser baseado no estado real e não em suposição.
async function lerArquivosMencionados(nomes) {
  const blocos = [];
  for (const nome of nomes.slice(0, 5)) { // limite de segurança
    const caminho = path.isAbsolute(nome) ? nome : path.join(WORKSPACE, nome);
    let conteudo;
    try {
      conteudo = await executeTool('ler_arquivo', { caminho });
    } catch {
      continue;
    }
    if (!conteudo || conteudo.startsWith('Arquivo não encontrado') || conteudo.startsWith('Erro')) continue;
    blocos.push(`--- ${nome} (conteúdo atual, ${caminho}) ---\n${conteudo}`);
  }
  return blocos.join('\n\n');
}

// Extrai CAMINHOS COMPLETOS de arquivos mencionados na mensagem (ex:
// "salve em D:\ia local\projetos\teste.txt" ou "crie na pasta C:\Users\...").
// Diferente de extrairPastaOuArquivoAbsoluto (que pega só o final da frase),
// essa versão varre a mensagem inteira em busca de padrões de caminho do Windows.
function extrairCaminhosCompletosDaMensagem(msg) {
  const caminhos = [];
  // Padrão 1: caminho absoluto do Windows completo (ex: D:\pasta\arquivo.txt)
  const regex1 = /[A-Za-z]:\\[\w\s\\.-]+\.[a-zA-Z0-9]+/g;
  let m;
  while ((m = regex1.exec(msg)) !== null) {
    caminhos.push(m[0].trim());
  }
  // Padrão 2: mencionado como "na pasta X" ou "no arquivo X" no fim da frase
  const pastaOuArquivo = extrairPastaOuArquivoAbsoluto(msg);
  if (pastaOuArquivo && !caminhos.includes(pastaOuArquivo)) {
    caminhos.push(pastaOuArquivo);
  }
  return [...new Set(caminhos)];
}

async function planejar(conversationHistory, systemPrompt, mensagemUsuario, arquivosMencionados) {
  const contextoArquivos = await lerArquivosMencionados(arquivosMencionados);
  const caminhosCompletos = extrairCaminhosCompletosDaMensagem(mensagemUsuario);

  // O formato do plano agora começa pedindo pro modelo CLASSIFICAR a tarefa
  // antes de planejar de fato — isso força uma etapa explícita de "pensar no
  // tamanho/tipo" em vez de já sair listando arquivos no primeiro impulso.
  // Um modelo pequeno faz o que a instrução pede; sem essa classificação
  // explícita, ele tende a tratar tudo do mesmo jeito (um pedido de história
  // e um pedido de sistema completo recebiam o mesmo "ARQUIVOS:/LÓGICA:"
  // genérico antes disso).
  const instrucaoPlano = {
    role: 'system',
    content:
      (contextoArquivos
        ? `Conteúdo atual dos arquivos mencionados pelo usuário (use isso como base real do que já existe — não invente o que já está aqui, e não recrie do zero o que já funciona):\n\n${contextoArquivos}\n\n`
        : '') +
      (caminhosCompletos.length > 0
        ? `⚠️ LOCALIZAÇÃO EXPLÍCITA PEDIDA PELO USUÁRIO: o usuário mencionou estes caminhos completos na mensagem: ${caminhosCompletos.join(', ')}. \nUSE ESSES CAMINHOS EXATOS (ou subpastas deles) quando listar os arquivos em "ARQUIVOS:". NÃO invente outros locais.\n\n`
        : '') +
      'Antes de usar qualquer ferramenta, escreva um plano curto. Primeiro classifique a tarefa, depois siga o formato certo pra essa classificação.\n\n' +
      'Comece SEMPRE com estas duas linhas:\n' +
      'TIPO: codigo | narrativo | pesquisa  (escolha uma)\n' +
      'RESULTADO ESPERADO: uma frase dizendo o que precisa estar pronto/verdadeiro no final pra essa tarefa ser considerada concluída\n\n' +
      'Se TIPO for "codigo", continue com:\n' +
      'TAMANHO: pequeno | grande  (pequeno = cabe bem em 1-2 arquivos; grande = melhor dividir em módulos/arquivos separados)\n' +
      'ARQUIVOS:\n' +
      '- caminho/do/arquivo.ext: o que esse arquivo faz\n' +
      '(uma linha por arquivo que será criado ou modificado; se for editar um arquivo existente, diga o que muda nele; SE O USUÁRIO MENCIONOU UM CAMINHO COMPLETO, USE ESSE CAMINHO EXATO AQUI)\n' +
      'LÓGICA:\n' +
      '- lógica principal (loop do jogo, colisão, controles, regras, fluxo de dados, etc.)\n' +
      '- se TAMANHO for "grande": quais são as funções/módulos principais, o que cada um faz, e como eles se conectam\n' +
      '- como o usuário interage com o sistema (o que ele vê na tela, o que clica, o que digita)\n\n' +
      'Se TIPO for "narrativo" (história, roteiro, poema, texto livre), continue com:\n' +
      'ESTRUTURA:\n' +
      '- Início: o que apresenta/estabelece\n' +
      '- Meio: o que se desenvolve ou complica\n' +
      '- Fim: como resolve, de um jeito que faça sentido com o início e o meio\n\n' +
      'Se TIPO for "pesquisa", continue com:\n' +
      'PERGUNTAS A RESPONDER:\n' +
      '- liste as perguntas concretas que a pesquisa precisa responder\n\n' +
      'NÃO chame nenhuma ferramenta nesta resposta — só escreva o plano em texto, seguindo esse formato.'
  };
  const msgs = [{ role: 'system', content: systemPrompt }, ...conversationHistory, instrucaoPlano];
  const resposta = await chamarLLM(msgs, { toolChoice: 'none' });
  return resposta.choices[0].message.content || '';
}

// Extrai os caminhos de arquivo prometidos na seção "ARQUIVOS:" do plano,
// junto com a descrição de cada um (usada depois pra gerar o conteúdo real).
function extrairArquivosComDescricaoDoPlano(plano) {
  const arquivos = [];
  const vistos = new Set();
  const linhas = plano.split('\n');
  
  for (const linha of linhas) {
    if (!linha.trim().startsWith('-')) continue;
    
    // Remove o '-' inicial e o espaço após ele
    const conteudo = linha.trim().substring(1).trim();
    
    // Procura por um padrão onde temos um caminho com extensão seguido por ": descrição"
    // A chave aqui é encontrar a EXTENSÃO do arquivo (.txt, .js, .html, etc.) e depois
    // procurar o primeiro ":" após essa extensão — esse é o separador caminho/descrição
    const matchArquivo = conteudo.match(/^(.+?\.\w+)\s*:\s*(.*)$/);
    if (!matchArquivo) continue;
    
    const caminho = matchArquivo[1].trim();
    const descricao = matchArquivo[2].trim();
    
    // Valida que parece ser um caminho de arquivo (tem extensão válida)
    if (!/\.[a-zA-Z0-9]+$/.test(caminho)) continue;
    
    // Evita duplicatas
    if (vistos.has(caminho)) continue;
    vistos.add(caminho);
    
    arquivos.push({ caminho, descricao });
  }
  
  return arquivos;
}

// Mantida por compatibilidade — só os caminhos, sem descrição.
function extrairArquivosDoPlano(plano) {
  return extrairArquivosComDescricaoDoPlano(plano).map(f => f.caminho);
}

// Extrai o contexto adicional do plano — seja a seção "LÓGICA:" (tarefas de
// código) ou "ESTRUTURA:" (tarefas narrativas) ou "PERGUNTAS A RESPONDER:"
// (pesquisa). É esse contexto que viaja junto em cada chamada de geração e
// revisão, pra manter consistência com o que foi planejado originalmente.
function extrairContextoDoPlano(plano) {
  const marcadores = ['LÓGICA:', 'LOGICA:', 'ESTRUTURA:', 'PERGUNTAS A RESPONDER:'];
  const planoMaiusculo = plano.toUpperCase();
  for (const marcador of marcadores) {
    const idx = planoMaiusculo.indexOf(marcador);
    if (idx !== -1) return plano.slice(idx + marcador.length).trim().slice(0, 1800);
  }
  return '';
}

// Extrai a linha "RESULTADO ESPERADO:" — a definição de "pronto" pra essa
// tarefa. Isso é injetado em TODA chamada de geração/revisão daqui pra
// frente (ver executarEtapasProjeto, gerarConteudoArquivo, etc.), pra que o
// agente não perca de vista o objetivo final enquanto trabalha arquivo por
// arquivo — é a peça que resolve "não se perder e manter o foco no resultado
// esperado".
function extrairResultadoEsperadoDoPlano(plano) {
  const m = plano.match(/RESULTADO ESPERADO:\s*(.*)/i);
  return m ? m[1].trim().slice(0, 300) : '';
}

function extrairTamanhoDoPlano(plano) {
  const m = plano.match(/TAMANHO:\s*(pequeno|grande)/i);
  return m ? m[1].toLowerCase() : '';
}

function nomeBase(caminho) {
  return caminho.replace(/\\/g, '/').split('/').pop().toLowerCase();
}

// ============ GERAÇÃO DIRETA DE CADA ARQUIVO ============
// PROBLEMA QUE ISSO RESOLVE: antes, era o próprio modelo quem decidia chamar
// criar_arquivo(caminho, conteudo) via tool_calls — o que obriga o modelo a
// colocar o código INTEIRO dentro de uma string de um JSON de function-call
// (escapando aspas, quebras de linha, barras invertidas etc.). Modelos
// pequenos (ex: qwen 1.5b) são muito ruins nisso: eles sabem escrever
// código normalmente em texto solto, mas ao tentar empacotar um arquivo
// grande dentro de argumentos JSON, truncam ou devolvem uma string vazia —
// daí os arquivos "quase vazios" mesmo quando o modelo "sabe" programar.
//
// SOLUÇÃO: pra cada arquivo listado no plano, o agente faz uma chamada
// dedicada com tool_choice: 'none' (sem tool-calling), pedindo só um bloco
// de código markdown com o conteúdo completo do arquivo. O AGENTE (código
// JS, não o modelo) extrai esse bloco e chama criar_arquivo diretamente.
// O modelo nunca precisa colocar código grande dentro de um JSON.

const CONTEUDO_MINIMO_ACEITAVEL = 30; // caracteres; abaixo disso, consideramos que a geração falhou
const MAX_CHARS_ARQUIVO_IRMAO = 2000; // trunca cada arquivo-irmão no contexto pra não estourar o contexto do modelo

function extrairBlocoCodigo(texto) {
  if (!texto) return '';
  // Bloco cercado por ``` (com ou sem linguagem declarada, ex: ```html)
  const match = texto.match(/```[a-zA-Z0-9_+-]*\r?\n([\s\S]*?)```/);
  if (match) return match[1].replace(/\s+$/, '');
  // Fallback: o modelo pode ignorar a instrução de usar crases e escrever
  // o código "solto". Nesse caso usamos o texto inteiro — ainda é melhor
  // que descartar a resposta.
  return texto.trim();
}

// Monta um bloco de texto com o conteúdo REAL dos arquivos já gerados nesta
// mesma rodada (não apenas uma nota dizendo que existem). Isso é o que
// permite, por exemplo, que script.js seja gerado sabendo os IDs exatos que
// index.html de fato usou — sem isso, o modelo só tem a descrição resumida
// do plano, que não garante os mesmos nomes.
function montarContextoArquivosIrmaos(conteudosGerados) {
  const entradas = Object.entries(conteudosGerados);
  if (entradas.length === 0) return '';
  const blocos = entradas.map(([caminho, conteudo]) => {
    const truncado = conteudo.length > MAX_CHARS_ARQUIVO_IRMAO
      ? conteudo.slice(0, MAX_CHARS_ARQUIVO_IRMAO) + '\n... [truncado]'
      : conteudo;
    return `--- ${caminho} ---\n${truncado}`;
  });
  return 'Conteúdo REAL dos arquivos já gerados neste mesmo projeto (use os MESMOS nomes de função/id/variável/import que aparecem aqui, não invente nomes diferentes):\n\n' + blocos.join('\n\n');
}

async function gerarConteudoArquivo(caminho, descricao, logica, resultadoEsperado, conteudosGerados, systemPrompt, conversationHistory) {
  const contextoIrmaos = montarContextoArquivosIrmaos(conteudosGerados);
  const instrucao = {
    role: 'system',
    content:
      `Escreva agora o conteúdo COMPLETO e FUNCIONAL do arquivo "${caminho}".\n` +
      (descricao ? `O que esse arquivo deve fazer, segundo o plano: ${descricao}\n` : '') +
      (resultadoEsperado ? `Resultado esperado do projeto inteiro (não perca isso de vista): ${resultadoEsperado}\n` : '') +
      (logica ? `Lógica geral do projeto:\n${logica}\n` : '') +
      (contextoIrmaos ? `\n${contextoIrmaos}\n` : '') +
      '\n⚠️ IMPORTANTE: depois de escrever o conteúdo, ele será salvo AUTOMATICAMENTE neste caminho exato: "' + caminho + '". Não escreva instruções do tipo "salve em X" ou "crie em Y" — apenas o conteúdo puro do arquivo.\n' +
      '\nResponda com APENAS um bloco de código cercado por três crases (```), contendo o conteúdo INTEIRO e funcional do arquivo — sem placeholders do tipo "// resto do código aqui" ou "// implementar depois", e sem nenhum texto de explicação antes ou depois do bloco.'
  };
  const msgs = [{ role: 'system', content: systemPrompt }, ...conversationHistory, instrucao];
  // Temperatura mais baixa que a conversa normal: gera código mais
  // consistente e determinístico, o que ajuda modelos pequenos a não
  // "perder o fio" no meio de um arquivo maior.
  const resposta = await chamarLLM(msgs, { toolChoice: 'none', temperature: 0.3 });
  const texto = resposta.choices[0]?.message?.content || '';
  return extrairBlocoCodigo(texto);
}

// ============ CHECAGEM DETERMINÍSTICA DE CONSISTÊNCIA (não depende do modelo "perceber") ============
// A revisão por IA é probabilística — pode ou não notar que um id usado no JS
// não existe no HTML. Isso aqui é uma checagem 100% determinística, feita em
// código: extrai os ids DECLARADOS no HTML e os ids REFERENCIADOS no JS via
// regex, e compara as duas listas. Se o resultado aponta um problema, a gente
// já entrega a resposta pronta pro modelo na revisão, em vez de pedir pra ele
// "procurar" — é a diferença entre avisar um erro exato e pedir um palpite.
function extrairIdsDeclarados(conteudoHtml) {
  const ids = new Set();
  const regex = /\bid\s*=\s*["']([a-zA-Z][\w-]*)["']/g;
  let m;
  while ((m = regex.exec(conteudoHtml)) !== null) ids.add(m[1]);
  return ids;
}

function extrairIdsReferenciados(conteudoJs) {
  const ids = new Set();
  const regexGetById = /getElementById\(\s*["']([a-zA-Z][\w-]*)["']\s*\)/g;
  const regexQuerySelectorId = /querySelector(?:All)?\(\s*["']#([a-zA-Z][\w-]*)["']\s*\)/g;
  let m;
  while ((m = regexGetById.exec(conteudoJs)) !== null) ids.add(m[1]);
  while ((m = regexQuerySelectorId.exec(conteudoJs)) !== null) ids.add(m[1]);
  return ids;
}

// Retorna null se não há nada pra checar (arquivo não é JS, ou nenhum HTML
// irmão foi gerado ainda), ou { faltando, disponiveis } se achar referência
// a um id que não existe em nenhum HTML já gerado neste projeto.
function verificarIdsInconsistentes(caminho, conteudo, conteudosGerados) {
  if (!/\.(js|jsx|ts|tsx)$/i.test(caminho)) return null;

  const idsReferenciados = extrairIdsReferenciados(conteudo);
  if (idsReferenciados.size === 0) return null;

  const idsDisponiveis = new Set();
  for (const [caminhoIrmao, conteudoIrmao] of Object.entries(conteudosGerados)) {
    if (/\.html?$/i.test(caminhoIrmao)) {
      for (const id of extrairIdsDeclarados(conteudoIrmao)) idsDisponiveis.add(id);
    }
  }
  if (idsDisponiveis.size === 0) return null; // nenhum HTML gerado ainda pra comparar

  const faltando = [...idsReferenciados].filter(id => !idsDisponiveis.has(id));
  if (faltando.length === 0) return null;

  return { faltando, disponiveis: [...idsDisponiveis] };
}

// ============ VERIFICAÇÃO REAL DE SINTAXE (não é a "opinião" do modelo) ============
// Assim como a checagem de ids, isso é determinístico — usa o próprio node
// (`node --check`) pra JS, que é muito mais confiável que pedir ao modelo
// pra "conferir se está tudo certo". Pra HTML, faz uma checagem heurística de
// tags balanceadas (não é um parser HTML completo, mas pega o erro mais
// comum de modelo pequeno: fechar tag errado ou esquecer de fechar por causa
// de truncamento).
function verificarSintaxeJs(conteudo) {
  const tmpPath = path.join(os.tmpdir(), `verificacao_sintaxe_${Date.now()}_${Math.random().toString(36).slice(2, 8)}.js`);
  try {
    fs.writeFileSync(tmpPath, conteudo, 'utf-8');
    execSync(`node --check "${tmpPath}"`, { stdio: 'pipe', timeout: 5000 });
    return { ok: true };
  } catch (e) {
    const mensagem = (e.stderr ? e.stderr.toString() : e.message || '').slice(0, 400);
    return { ok: false, erro: mensagem || 'erro de sintaxe não especificado' };
  } finally {
    try { fs.unlinkSync(tmpPath); } catch { /* ignora */ }
  }
}

const TAGS_VAZIAS_HTML = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr']);
// Tags que o HTML5 de verdade permite fechar implicitamente (o navegador
// fecha sozinho quando encontra o próximo elemento do mesmo nível). Fora
// dessa lista curta, exigimos fechamento explícito e exato — é isso que
// pega tag truncada/esquecida no meio de um arquivo grande.
const TAGS_AUTO_FECHAVEIS = new Set(['li', 'option', 'td', 'th', 'tr', 'thead', 'tbody', 'dt', 'dd', 'p']);

function verificarTagsHtmlBalanceadas(conteudo) {
  const regexTag = /<\/?([a-zA-Z][a-zA-Z0-9]*)\b[^>]*?(\/?)>/g;
  const pilha = [];
  let m;
  while ((m = regexTag.exec(conteudo)) !== null) {
    const tag = m[1].toLowerCase();
    const fechaSozinha = m[2] === '/';
    const ehFechamento = m[0].startsWith('</');
    if (TAGS_VAZIAS_HTML.has(tag) || fechaSozinha) continue;

    if (ehFechamento) {
      // Auto-fecha tags "tolerantes" que ficaram no topo (comportamento real do HTML5)
      while (pilha.length && pilha[pilha.length - 1] !== tag && TAGS_AUTO_FECHAVEIS.has(pilha[pilha.length - 1])) {
        pilha.pop();
      }
      if (pilha.length === 0 || pilha[pilha.length - 1] !== tag) {
        return { ok: false, erro: `Encontrei </${tag}> mas a tag aberta mais recente é ${pilha.length ? '<' + pilha[pilha.length - 1] + '>' : '(nenhuma)'} — provável tag não fechada corretamente.` };
      }
      pilha.pop();
    } else {
      pilha.push(tag);
    }
  }
  if (pilha.length > 0) return { ok: false, erro: `Tag(s) aberta(s) mas nunca fechada(s): ${[...new Set(pilha)].join(', ')}` };
  return { ok: true };
}

function verificarSintaxe(caminho, conteudo) {
  if (/\.(js|jsx)$/i.test(caminho)) return verificarSintaxeJs(conteudo);
  if (/\.(html?|htm)$/i.test(caminho)) return verificarTagsHtmlBalanceadas(conteudo);
  return { ok: true }; // outras extensões ainda não têm checagem determinística
}

// Pede pro modelo reescrever o arquivo INTEIRO corrigindo um erro específico
// e já confirmado por código (não uma suspeita) — usada na escalada de
// correção (ver executarEtapasProjeto). Temperatura decrescente a cada
// tentativa: quanto mais vezes falhou, mais conservador o pedido fica.
async function regenerarComCorrecao(caminho, conteudoAnterior, erro, descricao, logica, conteudosGerados, systemPrompt, conversationHistory, temperatura) {
  const contextoIrmaos = montarContextoArquivosIrmaos(conteudosGerados);
  const instrucao = {
    role: 'system',
    content:
      `A versão anterior do arquivo "${caminho}" tem um erro REAL, confirmado automaticamente (não é uma suposição): ${erro}\n` +
      'Reescreva o arquivo INTEIRO corrigindo especificamente esse erro. Mantenha o resto da lógica igual ao original.\n' +
      (descricao ? `O que o arquivo deve fazer: ${descricao}\n` : '') +
      (logica ? `Lógica geral do projeto:\n${logica}\n` : '') +
      (contextoIrmaos ? `\n${contextoIrmaos}\n` : '') +
      `\nVERSÃO ANTERIOR (com o erro):\n\`\`\`\n${conteudoAnterior}\n\`\`\`\n\n` +
      'Responda com APENAS um bloco de código cercado por três crases, com o conteúdo COMPLETO e corrigido do arquivo — sem nenhum texto fora do bloco.'
  };
  const msgs = [{ role: 'system', content: systemPrompt }, ...conversationHistory, instrucao];
  const resposta = await chamarLLM(msgs, { toolChoice: 'none', temperature: temperatura });
  const texto = resposta.choices[0]?.message?.content || '';
  return extrairBlocoCodigo(texto);
}

// ============ REVISÃO DE CADA ARQUIVO GERADO ============
// Pedido do usuário: depois de gerar um arquivo, revisar se está consistente
// (código: procurar bugs; texto: checar coerência) antes de considerar
// pronto. Mesmo princípio da revisão de conteúdo criativo: uma tarefa de
// revisão FOCADA num arquivo específico é muito mais fácil pra um modelo
// pequeno acertar do que gerar tudo perfeito já na primeira tentativa.
const EXTENSOES_CODIGO = /\.(html|htm|css|js|jsx|ts|tsx|py|json|sh|ps1|bat|sql|c|cpp|java|go|rb|php)$/i;

async function revisarArquivoGerado(caminho, conteudo, descricao, logica, resultadoEsperado, conteudosGerados, systemPrompt, conversationHistory, projeto) {
  const ehCodigo = EXTENSOES_CODIGO.test(caminho);
  const contextoIrmaos = montarContextoArquivosIrmaos(conteudosGerados);

  // Checagem determinística ANTES de perguntar pro modelo — se achar
  // problema, isso vira um aviso exato dentro da instrução de revisão.
  const inconsistenciaIds = verificarIdsInconsistentes(caminho, conteudo, conteudosGerados);
  const avisoDeterministico = inconsistenciaIds
    ? `\n⚠️ PROBLEMA DETECTADO POR CÓDIGO (checado de verdade, não é suposição): este arquivo referencia os ids [${inconsistenciaIds.faltando.join(', ')}] que NÃO existem em nenhum HTML já gerado neste projeto. Os ids que REALMENTE existem são: [${inconsistenciaIds.disponiveis.join(', ')}]. Corrija as referências pra usar os ids corretos da lista acima.\n`
    : '';
  if (inconsistenciaIds && projeto) {
    estado.registrarDecisao(projeto, `Checagem determinística encontrou ids inconsistentes em "${caminho}": ${inconsistenciaIds.faltando.join(', ')} (não existem no HTML gerado). Aviso explícito incluído na revisão.`);
  }

  const instrucaoRevisao = ehCodigo
    ? `Revise com atenção o conteúdo do arquivo "${caminho}" (colado abaixo). Procure especificamente por:\n` +
      '- Erros de sintaxe (chaves/parênteses/tags não fechadas, vírgulas faltando)\n' +
      '- Funções ou variáveis usadas mas nunca definidas, ou definidas mas nunca usadas\n' +
      '- Lógica incompleta, contraditória, ou que não faz o que foi pedido\n' +
      '- Trechos com placeholder tipo "implementar depois"\n' +
      '- Nomes de função/id/variável/import que deveriam bater com os outros arquivos do projeto (veja o conteúdo deles abaixo) mas estão diferentes\n' +
      avisoDeterministico + '\n' +
      (descricao ? `O que esse arquivo deveria fazer, segundo o plano: ${descricao}\n` : '') +
      (resultadoEsperado ? `Resultado esperado do projeto inteiro: ${resultadoEsperado}\n` : '') +
      (logica ? `Lógica geral do projeto:\n${logica}\n` : '') +
      (contextoIrmaos ? `\n${contextoIrmaos}\n` : '')
    : `Revise o conteúdo do arquivo de texto "${caminho}" (colado abaixo) quanto a consistência e coerência.\n` +
      (descricao ? `O que esse arquivo deveria conter, segundo o plano: ${descricao}\n` : '') +
      (resultadoEsperado ? `Resultado esperado do projeto inteiro: ${resultadoEsperado}\n` : '') +
      'Verifique se o conteúdo faz sentido do início ao fim, sem contradições internas (fatos, personagens, dados ou conclusões que se contradigam), corrija erros de gramática e concordância, e desenvolva partes que estejam rasas ou resumidas demais.\n' +
      (contextoIrmaos ? `\n${contextoIrmaos}\n` : '');

  const instrucao = {
    role: 'system',
    content:
      instrucaoRevisao +
      '\nSe encontrar problemas, corrija-os. Se já estiver correto, devolva o conteúdo como está, sem mudanças desnecessárias.\n' +
      'Responda com APENAS um bloco de código cercado por três crases (```), contendo a versão FINAL e completa do arquivo — sem nenhum comentário fora do bloco.\n\n' +
      `CONTEÚDO ATUAL DE "${caminho}":\n\`\`\`\n${conteudo}\n\`\`\``
  };
  const msgs = [{ role: 'system', content: systemPrompt }, ...conversationHistory, instrucao];
  const resposta = await chamarLLM(msgs, { toolChoice: 'none', temperature: 0.3 });
  const texto = resposta.choices[0]?.message?.content || '';
  const revisado = extrairBlocoCodigo(texto);

  // Rede de segurança: se a "revisão" vier vazia ou muito menor que o
  // original, o modelo provavelmente truncou/comeu o conteúdo em vez de
  // revisar de verdade — nesse caso mantemos o original, que é mais seguro
  // do que arriscar substituir por algo pior.
  if (!revisado || revisado.trim().length < conteudo.trim().length * 0.5) {
    return conteudo;
  }
  return revisado;
}

// ============ EXECUÇÃO DAS ETAPAS DE UM PROJETO (com checkpoint em disco) ============
// Compartilhada entre um projeto NOVO e a RETOMADA de um projeto interrompido
// (ver estado.js). Depois de cada etapa concluída ou com erro, o progresso é
// salvo em disco imediatamente (estado.marcarEtapaConcluida/registrarErro) —
// se o processo for fechado no meio, a próxima abertura retoma exatamente
// daqui, sem perder o que já foi feito nem precisar que o usuário repita nada.
function inferirNomeProjeto(mensagemUsuario, arquivosComDescricao) {
  for (const { caminho } of arquivosComDescricao) {
    const partes = caminho.replace(/\\/g, '/').split('/');
    if (partes.length > 1) return partes[0];
  }
  return mensagemUsuario.trim().slice(0, 40);
}

async function executarEtapasProjeto(projeto, systemPrompt, conversationHistory, onToolCall, conteudosGerados, arquivosCriados) {
  const logica = projeto.logica || '';
  const resultadoEsperado = projeto.resultadoEsperado || '';
  const pendentes = estado.etapasPendentes(projeto);

  for (const etapa of pendentes) {
    const { caminho, descricao, id } = etapa;
    if (onToolCall) onToolCall('gerando_arquivo', { caminho }, 'running');
    let conteudo = await gerarConteudoArquivo(caminho, descricao, logica, resultadoEsperado, conteudosGerados, systemPrompt, conversationHistory);

    if (conteudo && conteudo.trim().length >= CONTEUDO_MINIMO_ACEITAVEL) {
      if (onToolCall) onToolCall('revisando_arquivo', { caminho }, 'running');
      conteudo = await revisarArquivoGerado(caminho, conteudo, descricao, logica, resultadoEsperado, conteudosGerados, systemPrompt, conversationHistory, projeto);
      if (onToolCall) onToolCall('revisando_arquivo', { caminho }, 'done', 'Revisão concluída.');

      // ============ VERIFICAÇÃO REAL DE SINTAXE + ESCALADA ============
      // Diferente da revisão acima (que é uma opinião do modelo), isso é um
      // fato checado por código (node --check / tags balanceadas). Se falhar,
      // não fica só um aviso — o agente tenta corrigir de verdade, até 2
      // vezes, cada vez com temperatura mais baixa (mais conservadora) e
      // mostrando o erro exato. Isso é a "escalada": em vez de insistir do
      // mesmo jeito, o agente aperta o cinto a cada nova tentativa.
      let verificacao = verificarSintaxe(caminho, conteudo);
      let tentativaCorrecao = 0;
      while (!verificacao.ok && tentativaCorrecao < 2) {
        tentativaCorrecao++;
        if (onToolCall) onToolCall('corrigindo_sintaxe', { caminho, tentativa: tentativaCorrecao }, 'running');
        estado.registrarDecisao(projeto, `Sintaxe inválida em "${caminho}" (tentativa ${tentativaCorrecao}/2 de correção): ${verificacao.erro}`);
        const temperaturaEscalada = Math.max(0.1, 0.3 - tentativaCorrecao * 0.1);
        const corrigido = await regenerarComCorrecao(caminho, conteudo, verificacao.erro, descricao, logica, conteudosGerados, systemPrompt, conversationHistory, temperaturaEscalada);
        if (onToolCall) onToolCall('corrigindo_sintaxe', { caminho, tentativa: tentativaCorrecao }, 'done', verificacao.ok ? 'ok' : verificacao.erro);
        if (!corrigido || corrigido.trim().length < CONTEUDO_MINIMO_ACEITAVEL) break; // regeneração não voltou nada útil, para de insistir
        conteudo = corrigido;
        verificacao = verificarSintaxe(caminho, conteudo);
      }
      if (!verificacao.ok) {
        estado.registrarErro(projeto, id, `Sintaxe ainda inválida após ${tentativaCorrecao} tentativa(s) de correção: ${verificacao.erro}`);
        conversationHistory.push({
          role: 'system',
          content: `⚠️ Aviso: "${caminho}" foi salvo mesmo com um problema de sintaxe não resolvido automaticamente (${verificacao.erro}). Avise o usuário disso na resposta final.`
        });
      }

      const caminhoCompleto = path.isAbsolute(caminho) ? caminho : path.join(WORKSPACE, caminho);
      const resultado = await executeTool('criar_arquivo', { caminho: caminhoCompleto, conteudo });
      if (onToolCall) onToolCall('criar_arquivo', { caminho: caminhoCompleto }, 'done', resultado);
      conversationHistory.push({
        role: 'system',
        content: `Arquivo "${caminhoCompleto}" já foi gerado, revisado e salvo automaticamente (${conteudo.length} caracteres). Não recrie esse arquivo de novo, a menos que o usuário peça uma mudança nele.`
      });
      arquivosCriados.add(nomeBase(caminho));
      conteudosGerados[caminho] = conteudo;
      // CHECKPOINT: grava o progresso em disco imediatamente após a etapa.
      estado.marcarEtapaConcluida(projeto, id);
    } else {
      if (onToolCall) onToolCall('gerando_arquivo', { caminho }, 'done', 'Geração direta não retornou conteúdo suficiente — será tentado novamente como fallback.');
      estado.registrarErro(projeto, id, 'Geração direta não retornou conteúdo suficiente.');
      estado.registrarDecisao(projeto, `Pulei a geração direta de "${caminho}" (conteúdo insuficiente) — será tentado de novo via fallback de tool-calling mais adiante nesta mesma mensagem.`);
    }
  }
}

// ============ RESGATE DE CONTEÚDO ENTREGÁVEL ("slot" de análise da resposta) ============
// Falha observada na prática: o modelo às vezes recebe um pedido de
// construção, o PLANEJAMENTO não consegue extrair nenhum arquivo do formato
// esperado (então o loop de geração direta nunca roda), e o modelo cai de
// volta pra conversa normal — onde ele sabe o conteúdo certo, mas em vez de
// salvar, só EXPLICA em texto o que o usuário "deveria fazer".
//
// Isso aqui é a rede de segurança mais externa possível: depois que a
// resposta final já foi gerada, se a mensagem era claramente um pedido de
// construção e nenhum arquivo foi criado nesta rodada, o agente analisa a
// PRÓPRIA RESPOSTA em busca de um bloco de código — ou seja, separa o que é
// "conteúdo entregável" do que é "explicação em texto" dentro da mesma
// resposta — e, se achar, salva esse conteúdo de verdade em disco.
const LINGUAGEM_PARA_NOME_PADRAO = {
  html: 'index.html', htm: 'index.html',
  js: 'script.js', javascript: 'script.js', jsx: 'componente.jsx',
  css: 'style.css',
  py: 'main.py', python: 'main.py',
  json: 'dados.json',
  sh: 'script.sh', bash: 'script.sh',
  bat: 'script.bat', ps1: 'script.ps1',
  sql: 'consulta.sql'
};

function detectarConteudoEntregavelNaResposta(mensagemUsuario, respostaFinal) {
  const match = respostaFinal.match(/```([a-zA-Z0-9]*)\r?\n([\s\S]*?)```/);
  if (!match) return { encontrado: false };

  const linguagem = (match[1] || '').toLowerCase();
  const conteudo = match[2].trim();
  if (conteudo.length < CONTEUDO_MINIMO_ACEITAVEL) return { encontrado: false };

  const arquivosMencionadosMsg = extrairArquivosMencionados(mensagemUsuario);
  const pastaOuArquivo = extrairPastaOuArquivoAbsoluto(mensagemUsuario);
  const jaEhArquivoCompleto = pastaOuArquivo && /\.[a-zA-Z0-9]{1,5}$/.test(pastaOuArquivo);

  let caminho;
  if (jaEhArquivoCompleto) {
    caminho = pastaOuArquivo; // usuário já deu caminho completo com nome de arquivo
  } else {
    const nomeArquivo = arquivosMencionadosMsg[0] || LINGUAGEM_PARA_NOME_PADRAO[linguagem] || 'arquivo_gerado.txt';
    caminho = pastaOuArquivo ? path.join(pastaOuArquivo, nomeArquivo) : nomeArquivo;
  }
  return { encontrado: true, caminho, conteudo };
}


// Modelos pequenos escrevem rascunhos melhores quando a tarefa é focada.
// "Escreva uma história/pesquisa/análise boa" é uma tarefa aberta e difícil;
// "revise este texto específico" é uma tarefa fechada e muito mais fácil pra
// um modelo de poucos parâmetros. Por isso, depois que a resposta final é
// gerada, se a mensagem foi tratada como uma tarefa de conteúdo (não uma
// pergunta rápida de conversa) E não resultou num arquivo (que já passa pela
// revisão em revisarArquivoGerado, acima), fazemos mais UMA chamada pedindo
// só a revisão. Isso não depende do TIPO de conteúdo — vale igual pra
// história, pesquisa, resumo, explicação ou análise.
async function revisarRespostaFinal(textoOriginal, resultadoEsperado, systemPrompt, conversationHistory) {
  const instrucao = {
    role: 'system',
    content:
      'Revise a resposta que você acabou de dar (colada abaixo), seja ela uma história, pesquisa, análise, resumo ou explicação:\n' +
      (resultadoEsperado ? `Resultado esperado desta tarefa (confira se a resposta realmente cumpre isso): ${resultadoEsperado}\n` : '') +
      '- Corrija erros de concordância verbal e nominal e gramática em geral\n' +
      '- Verifique se não há contradições internas (fatos, personagens, dados ou conclusões que se contradigam)\n' +
      '- Se for uma narrativa/roteiro, confira se tem início, meio e fim que façam sentido entre si — não só uma sequência solta de fatos\n' +
      '- Se algum trecho estiver raso ou parecer um resumo apressado em vez de desenvolvido de verdade, desenvolva-o\n' +
      '- Mantenha um tamanho parecido ou maior, nunca mais curto\n' +
      '- Responda APENAS com o texto final revisado, sem comentários tipo "aqui está a versão revisada"\n\n' +
      `TEXTO A REVISAR:\n${textoOriginal}`
  };
  const msgs = [{ role: 'system', content: systemPrompt }, ...conversationHistory, instrucao];
  const resposta = await chamarLLM(msgs, { toolChoice: 'none', temperature: 0.6 });
  const revisado = resposta.choices[0]?.message?.content?.trim();
  return revisado && revisado.length >= textoOriginal.length * 0.7 ? revisado : textoOriginal;
}

// ============ LOOP DO AGENTE ============
const MAX_HISTORY = 30;
const MAX_ITERACOES = 15; // era 10 — as tentativas extras de correção do plano usam esse mesmo teto

/**
 * Executa uma lista de tool_calls, atualizando o histórico e o set de
 * arquivos criados/editados nesta rodada. Compartilhado entre o loop
 * principal, o fallback de JSON solto, e a verificação pós-plano.
 */
async function executarToolCalls(toolCalls, conversationHistory, onToolCall, arquivosCriados) {
  for (const toolCall of toolCalls) {
    const funcName = toolCall.function.name;
    let funcArgs;
    try {
      funcArgs = JSON.parse(toolCall.function.arguments);
    } catch {
      funcArgs = {};
    }

    if (onToolCall) onToolCall(funcName, funcArgs, 'running');
    const resultado = await executeTool(funcName, funcArgs);
    if (onToolCall) onToolCall(funcName, funcArgs, 'done', resultado);

    if (funcName === 'criar_arquivo' && /criado com sucesso/i.test(resultado) && funcArgs.caminho) {
      arquivosCriados.add(nomeBase(funcArgs.caminho));
    }

    conversationHistory.push({ role: 'tool', tool_call_id: toolCall.id, content: resultado });
  }
}

/**
 * Roda uma rodada completa do agente: manda a mensagem, executa as tools
 * que o modelo pedir, e repete até ele responder com texto final.
 *
 * @param {string} mensagemUsuario
 * @param {Array} conversationHistory - histórico mutável (array), é alterado in-place
 * @param {(name: string, args: object, status: 'running'|'done', result?: string) => void} onToolCall - callback opcional pra UI
 * @param {(fase: string) => void} onPensando - callback opcional pra avisar "pensando..."
 */
export async function agenteLoop(mensagemUsuario, conversationHistory, onToolCall, onPensando) {
  conversationHistory.push({ role: 'user', content: mensagemUsuario });
  if (conversationHistory.length > MAX_HISTORY) {
    conversationHistory.splice(0, conversationHistory.length - MAX_HISTORY);
  }

  const systemPrompt = buildSystemPrompt();
  const montarMensagens = () => [{ role: 'system', content: systemPrompt }, ...conversationHistory];
  const arquivosCriados = new Set();
  let arquivosPlanejados = [];

  const arquivosMencionados = extrairArquivosMencionados(mensagemUsuario);
  const pedidoDeConstrucao = isPedidoDeConstrucao(mensagemUsuario, arquivosMencionados);
  const conteudosGerados = {};
  let projetoAtual = null; // referência ao projeto (retomado ou novo) pra registrar decisões mais adiante
  let resultadoEsperadoAtual = ''; // "definição de pronto" — usada até na resposta final, mesmo sem arquivo

  // ============ RETOMADA DE PROJETO INTERROMPIDO ============
  // Se existe exatamente um projeto "em_andamento" salvo em disco e a
  // mensagem é uma confirmação/continuação curta ("sim", "continua"...), o
  // agente retoma exatamente da etapa onde parou — sem replanejar do zero e
  // sem precisar que o usuário repita nada, mesmo que o processo tenha sido
  // fechado e reaberto entre as duas mensagens (ver estado.js).
  const projetoPendente = estado.projetoEmAndamentoUnico();
  const ehContinuacaoCurta = CONFIRMACAO_CURTA.test(mensagemUsuario.trim());

  if (projetoPendente && ehContinuacaoCurta) {
    if (onToolCall) onToolCall('retomando_projeto', { projeto: projetoPendente.projeto }, 'done', estado.resumoProjeto(projetoPendente));
    estado.registrarDecisao(projetoPendente, `Retomado automaticamente na etapa ${projetoPendente.etapaAtual} de ${projetoPendente.etapas.length}, por causa da mensagem de continuação: "${mensagemUsuario.trim().slice(0, 80)}".`);
    conversationHistory.push({
      role: 'system',
      content: `Retomando o projeto "${projetoPendente.projeto}" de onde parou (não replaneje, só continue a partir daqui):\n${estado.resumoProjeto(projetoPendente)}`
    });

    // Relê do disco o conteúdo das etapas já concluídas, pra manter o
    // contexto real dos arquivos-irmãos mesmo depois de reiniciar o processo
    // (a RAM da rodada anterior se perdeu, mas os arquivos em disco não).
    for (const et of projetoPendente.etapas) {
      if (et.status === 'concluida') {
        const caminhoCompleto = path.isAbsolute(et.caminho) ? et.caminho : path.join(WORKSPACE, et.caminho);
        const conteudoExistente = await executeTool('ler_arquivo', { caminho: caminhoCompleto });
        if (conteudoExistente && !/^(Arquivo não encontrado|Erro)/.test(conteudoExistente)) {
          conteudosGerados[et.caminho] = conteudoExistente;
          arquivosCriados.add(nomeBase(et.caminho));
        }
      }
    }

    arquivosPlanejados = projetoPendente.etapas.map(e => e.caminho);
    projetoAtual = projetoPendente;
    resultadoEsperadoAtual = projetoPendente.resultadoEsperado || '';
    if (onPensando) onPensando('processando');
    await executarEtapasProjeto(projetoPendente, systemPrompt, conversationHistory, onToolCall, conteudosGerados, arquivosCriados);
  } else if (pedidoDeConstrucao) {
    if (onPensando) onPensando('planejando');
    const plano = await planejar(conversationHistory, systemPrompt, mensagemUsuario, arquivosMencionados);
    if (plano.trim()) {
      conversationHistory.push({ role: 'assistant', content: `[Plano antes de executar]\n${plano.trim()}` });
      if (onToolCall) onToolCall('planejamento', {}, 'done', plano.trim());

      const arquivosComDescricao = extrairArquivosComDescricaoDoPlano(plano);
      const logica = extrairContextoDoPlano(plano);
      const resultadoEsperado = extrairResultadoEsperadoDoPlano(plano);
      const tamanho = extrairTamanhoDoPlano(plano);
      arquivosPlanejados = arquivosComDescricao.map(f => f.caminho);
      resultadoEsperadoAtual = resultadoEsperado;

      // Salva um resumo do plano na memória geral — vira contexto automático
      // nas próximas conversas (memoria.json, sem relação com o estado do
      // projeto abaixo).
      const chave = mensagemUsuario.trim().slice(0, 50).toLowerCase().replace(/[^\w\s]/g, '').replace(/\s+/g, '_');
      await executeTool('salvar_memoria', { categoria: 'projetos', chave, valor: plano.trim().slice(0, 300) });

      // Cria o ESTADO PERSISTENTE do projeto (slots em disco — ver estado.js):
      // cada arquivo do plano vira uma etapa rastreável, que sobrevive a um
      // fechamento do programa. Isso substitui a antiga dependência de o
      // modelo chamar criar_arquivo via tool_calls e de tudo viver só na RAM.
      const nomeProjeto = inferirNomeProjeto(mensagemUsuario, arquivosComDescricao);
      const projetoNovo = estado.criarProjeto(nomeProjeto, mensagemUsuario, arquivosComDescricao, logica, resultadoEsperado, tamanho);
      projetoAtual = projetoNovo;
      estado.registrarDecisao(projetoNovo, `Plano criado (tamanho: ${tamanho || 'não especificado'}) com ${arquivosComDescricao.length} etapa(s) a partir do pedido: "${mensagemUsuario.trim().slice(0, 100)}".`);
      if (onToolCall) onToolCall('projeto_criado', { projeto: nomeProjeto, etapas: arquivosComDescricao.length }, 'done', `Projeto "${nomeProjeto}" registrado com ${arquivosComDescricao.length} etapa(s)${resultadoEsperado ? ' — resultado esperado: ' + resultadoEsperado : ''}.`);

      await executarEtapasProjeto(projetoNovo, systemPrompt, conversationHistory, onToolCall, conteudosGerados, arquivosCriados);
    }
  }

  if (onPensando) onPensando('pensando');
  let resposta = await chamarLLM(montarMensagens());
  let message = resposta.choices[0].message;

  let iteracoes = 0;
  while (message.tool_calls && message.tool_calls.length > 0 && iteracoes < MAX_ITERACOES) {
    iteracoes++;
    conversationHistory.push(message);
    await executarToolCalls(message.tool_calls, conversationHistory, onToolCall, arquivosCriados);

    if (onPensando) onPensando('processando');
    resposta = await chamarLLM(montarMensagens());
    message = resposta.choices[0].message;
  }

  // Fallback: o modelo pode ter escrito a tool call como JSON solto no texto
  // em vez de usar o campo tool_calls oficial. Só entra aqui se ainda não
  // tiver estourado o limite de iterações no loop oficial acima.
  while (!message.tool_calls?.length && message.content && iteracoes < MAX_ITERACOES) {
    const detectadas = detectarToolCallsNoTexto(message.content);
    if (detectadas.length === 0) break;

    iteracoes++;
    conversationHistory.push({ role: 'assistant', content: message.content });

    const toolCallsFicticios = detectadas.map(tc => ({
      id: 'fb_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6),
      function: { name: tc.name, arguments: JSON.stringify(tc.arguments) }
    }));
    await executarToolCalls(toolCallsFicticios, conversationHistory, onToolCall, arquivosCriados);

    if (onPensando) onPensando('processando');
    resposta = await chamarLLM(montarMensagens());
    message = resposta.choices[0].message;
  }

  // ============ VERIFICAÇÃO DO PLANO ============
  // Compara o que foi prometido em "ARQUIVOS:" com o que de fato foi criado
  // nesta rodada (seja pela geração direta acima, seja pelo modelo via
  // tool_calls). Se faltar algo — por exemplo, a geração direta falhou pra
  // algum arquivo — dá mais chances ao modelo de terminar em vez de deixá-lo
  // simplesmente esquecer parte do plano.
  //
  // Antes: só UMA chance. Modelos pequenos às vezes precisam de 2-3 empurrões
  // pra realmente terminar tudo, então isso agora repete até completar ou até
  // um limite de tentativas — sem virar loop infinito (MAX_ITERACOES protege).
  const MAX_TENTATIVAS_CORRECAO = 3;

  if (arquivosPlanejados.length > 0 && iteracoes < MAX_ITERACOES) {
    let tentativa = 0;
    let faltando = arquivosPlanejados.filter(a => !arquivosCriados.has(nomeBase(a)));

    while (faltando.length > 0 && tentativa < MAX_TENTATIVAS_CORRECAO && iteracoes < MAX_ITERACOES) {
      tentativa++;
      conversationHistory.push({
        role: 'system',
        content:
          `Verificação do plano (tentativa ${tentativa}/${MAX_TENTATIVAS_CORRECAO}): você prometeu criar/editar estes arquivos mas eles ainda não foram criados nesta conversa: ${faltando.join(', ')}. ` +
          'Se ainda forem necessários, crie-os agora com criar_arquivo antes de responder. Se não forem mais necessários (ex: você mudou de abordagem), pode ignorar e explicar isso na resposta final.'
      });

      if (onPensando) onPensando('processando');
      resposta = await chamarLLM(montarMensagens());
      message = resposta.choices[0].message;
      iteracoes++;

      while (message.tool_calls && message.tool_calls.length > 0 && iteracoes < MAX_ITERACOES) {
        iteracoes++;
        conversationHistory.push(message);
        await executarToolCalls(message.tool_calls, conversationHistory, onToolCall, arquivosCriados);

        if (onPensando) onPensando('processando');
        resposta = await chamarLLM(montarMensagens());
        message = resposta.choices[0].message;
      }

      faltando = arquivosPlanejados.filter(a => !arquivosCriados.has(nomeBase(a)));
    }

    if (faltando.length > 0) {
      conversationHistory.push({
        role: 'system',
        content:
          `Depois de ${MAX_TENTATIVAS_CORRECAO} tentativas ainda faltam estes arquivos do plano: ${faltando.join(', ')}. ` +
          'Explique claramente isso na resposta final pro usuário, incluindo o motivo se souber, em vez de fingir que terminou.'
      });
      if (projetoAtual) {
        estado.registrarDecisao(projetoAtual, `Depois de ${MAX_TENTATIVAS_CORRECAO} tentativas de correção, ainda faltam: ${faltando.join(', ')}. Projeto ficou com etapas pendentes/erro em vez de ser marcado como concluído.`);
      }
    }
  }

  if (iteracoes >= MAX_ITERACOES) {
    conversationHistory.push({
      role: 'assistant',
      content: '(parei depois de 10 chamadas de ferramentas seguidas pra evitar um loop infinito — me avise se precisar continuar)'
    });
    return conversationHistory[conversationHistory.length - 1].content;
  }

  let respostaFinal = message.content || '(sem resposta)';

  // ============ RESGATE: a resposta trouxe o conteúdo, mas nenhum arquivo
  // foi salvo? Extrai o bloco de código e salva de verdade. Ver explicação
  // em "RESGATE DE CONTEÚDO ENTREGÁVEL" acima.
  if (pedidoDeConstrucao && arquivosCriados.size === 0) {
    const resgate = detectarConteudoEntregavelNaResposta(mensagemUsuario, respostaFinal);
    if (resgate.encontrado) {
      const caminhoCompleto = path.isAbsolute(resgate.caminho) ? resgate.caminho : path.join(WORKSPACE, resgate.caminho);
      if (onToolCall) onToolCall('resgate_conteudo', { caminho: caminhoCompleto }, 'running');
      const resultado = await executeTool('criar_arquivo', { caminho: caminhoCompleto, conteudo: resgate.conteudo });
      if (onToolCall) onToolCall('resgate_conteudo', { caminho: caminhoCompleto }, 'done', resultado);
      if (projetoAtual) {
        estado.registrarDecisao(projetoAtual, `A resposta trouxe o conteúdo em texto/instruções em vez de salvar o arquivo. O agente extraiu o bloco de código da própria resposta e salvou automaticamente em "${caminhoCompleto}".`);
      }
      arquivosCriados.add(nomeBase(caminhoCompleto));
      respostaFinal = `✅ Arquivo criado e salvo em: ${caminhoCompleto}\n\n${respostaFinal}`;
    }
  }

  // Passada extra de revisão quando a mensagem foi tratada como uma tarefa de
  // conteúdo mas não gerou nenhum arquivo (esse caso já é revisado em
  // revisarArquivoGerado, acima) — cobre história, pesquisa, resumo, análise
  // e qualquer outro texto que ficou só na resposta do chat.
  if (pedidoDeConstrucao && arquivosCriados.size === 0 && respostaFinal.length > 20 && iteracoes < MAX_ITERACOES) {
    if (onPensando) onPensando('processando');
    respostaFinal = await revisarRespostaFinal(respostaFinal, resultadoEsperadoAtual, systemPrompt, conversationHistory);
  }

  conversationHistory.push({ role: 'assistant', content: respostaFinal });
  return respostaFinal;
}

// ============ GERENCIAMENTO DE PROJETOS (pra comandos no index.js) ============
// Fininhas de propósito — toda a lógica real de estado mora em estado.js;
// aqui é só a ponte pro index.js não precisar importar estado.js diretamente.

/** Marca um projeto (por nome ou pela versão "slugificada" dele) como abandonado. Retorna o projeto ou null se não encontrar. */
export function abandonarProjeto(nomeOuChave) {
  const projeto = estado.carregarProjeto(nomeOuChave);
  if (!projeto) return null;
  estado.marcarAbandonado(projeto);
  estado.registrarDecisao(projeto, 'Marcado como abandonado manualmente pelo usuário.');
  return projeto;
}

/** Lista os projetos ainda em andamento (não concluídos nem abandonados). */
export function listarProjetosEmAndamento() {
  return estado.listarProjetosEmAndamento();
}

/** Resumo textual de um projeto específico, pro comando /projetos ou /projeto <nome>. */
export function verResumoProjeto(nomeOuChave) {
  const projeto = estado.carregarProjeto(nomeOuChave);
  return projeto ? estado.resumoProjeto(projeto) : null;
}

/**
 * Replanejamento PARCIAL e ADITIVO: pergunta ao modelo se, olhando pro pedido
 * original (e um pedido extra opcional do usuário) e o que já está no plano,
 * falta algum arquivo. Nunca remove ou reordena etapas já existentes — só
 * pode ADICIONAR etapas novas no fim. Isso é intencionalmente conservador:
 * um plano errado vira "faltou alguma coisa, adiciona", nunca "apaga o que
 * já foi feito", que seria arriscado demais pra um modelo pequeno decidir.
 */
export async function revisarPlanoProjeto(nomeOuChave, pedidoExtra = '') {
  const projeto = estado.carregarProjeto(nomeOuChave);
  if (!projeto) return { ok: false, mensagem: `Nenhum projeto encontrado com "${nomeOuChave}".`, adicionadas: [] };

  const systemPrompt = buildSystemPrompt();
  const listaEtapas = projeto.etapas.map(e => `- ${e.caminho} (${e.status}): ${e.descricao}`).join('\n');
  const instrucao = {
    role: 'system',
    content:
      `Revise o plano do projeto "${projeto.projeto}".\n\n` +
      `Pedido original: "${projeto.pedidoOriginal}"\n` +
      (pedidoExtra ? `Pedido adicional agora: "${pedidoExtra}"\n` : '') +
      `\nEtapas (arquivos) que já estão no plano:\n${listaEtapas}\n\n` +
      'Olhando pro pedido (original e o adicional, se houver), falta algum arquivo pra cumprir tudo? ' +
      'Se sim, liste APENAS os arquivos NOVOS (que ainda não aparecem na lista acima) neste formato exato:\n' +
      'ARQUIVOS:\n- caminho/do/arquivo.ext: o que esse arquivo faz\n\n' +
      'Se a lista atual já cobre tudo, responda apenas: NENHUMA MUDANÇA NECESSÁRIA'
  };
  const resposta = await chamarLLM([{ role: 'system', content: systemPrompt }, instrucao], { toolChoice: 'none' });
  const texto = resposta.choices[0]?.message?.content || '';

  if (/NENHUMA MUDAN[ÇC]A/i.test(texto)) {
    return { ok: true, adicionadas: [], mensagem: 'O plano já cobre tudo — nenhuma etapa nova foi adicionada.' };
  }

  const novasEtapas = extrairArquivosComDescricaoDoPlano(texto);
  const adicionadas = estado.adicionarEtapas(projeto, novasEtapas);
  estado.registrarDecisao(
    projeto,
    `Replanejamento manual: ${adicionadas.length ? 'adicionou ' + adicionadas.map(a => a.caminho).join(', ') : 'nenhuma etapa nova de fato (modelo sugeriu algo que já existia).'}`
  );

  return {
    ok: true,
    adicionadas,
    mensagem: adicionadas.length
      ? `Adicionei ${adicionadas.length} etapa(s) nova(s) ao plano. Mande "continua" pra executá-las.`
      : 'O modelo sugeriu mudanças, mas nenhuma era realmente nova — plano ficou como estava.'
  };
}
