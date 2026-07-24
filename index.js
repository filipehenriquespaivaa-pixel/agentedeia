import readline from 'readline';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { tools, executeTool, setConfirmador } from './tools.js';
import { MODEL, LM_STUDIO_BASE, getHeaders, agenteLoop } from './agente.js';

// ============ CORES ============
const c = {
  reset: '\x1b[0m', bold: '\x1b[1m', dim: '\x1b[2m', italic: '\x1b[3m',
  red: '\x1b[31m', green: '\x1b[32m', yellow: '\x1b[33m', blue: '\x1b[34m',
  magenta: '\x1b[35m', cyan: '\x1b[36m', white: '\x1b[37m', gray: '\x1b[90m',
  bgRed: '\x1b[41m', bgGreen: '\x1b[42m', bgYellow: '\x1b[43m',
  bgBlue: '\x1b[44m', bgMagenta: '\x1b[45m', bgCyan: '\x1b[46m',
};

// ============ LAYOUT ============
const LAYOUT = {
  headerHeight: 3,
  sidebarWidth: 35,
  statusHeight: 2,
};

function getTerminalSize() {
  const cols = process.stdout.columns || 100;
  const rows = process.stdout.rows || 30;
  return { cols, rows };
}

function clearScreen() {
  process.stdout.write('\x1b[2J\x1b[H');
}

function moveCursor(row, col) {
  process.stdout.write(`\x1b[${row};${col}H`);
}

function drawHeader() {
  const { cols } = getTerminalSize();
  const title = ' 🤖 AGENTE IA LOCAL ';
  const model = ` ${MODEL} `;
  const status = ' ● Conectado ';
  
  moveCursor(1, 1);
  process.stdout.write(`${c.bgCyan}${c.bold}${c.white}${title}${c.reset}`);
  process.stdout.write(`${c.bgBlue}${c.white}${model}${c.reset}`);
  process.stdout.write(`${' '.repeat(Math.max(0, cols - title.length - model.length - status.length))}`);
  process.stdout.write(`${c.bgGreen}${c.white}${status}${c.reset}\n`);
  
  moveCursor(2, 1);
  process.stdout.write(`${c.gray}${'─'.repeat(cols)}${c.reset}\n`);
}

function drawSidebar() {
  const { cols, rows } = getTerminalSize();
  const sidebarCol = cols - LAYOUT.sidebarWidth;
  const chatHeight = rows - LAYOUT.headerHeight - LAYOUT.statusHeight - 2;
  
  // Borda superior
  moveCursor(3, sidebarCol);
  process.stdout.write(`${c.gray}┌${'─'.repeat(LAYOUT.sidebarWidth - 2)}┐${c.reset}`);
  
  // Título ferramentas
  moveCursor(4, sidebarCol);
  process.stdout.write(`${c.gray}│${c.reset}${c.bold}${c.cyan} 🔧 FERRAMENTAS ${' '.repeat(LAYOUT.sidebarWidth - 18)}${c.gray}│${c.reset}`);
  
  // Lista de ferramentas
  const toolNames = [
    '📄 criar_arquivo',
    '✏️ editar_arquivo',
    '📖 ler_arquivo',
    '🗑️ apagar_arquivo',
    '🔀 mover_arquivo',
    '📁 listar_diretorio',
    '📂 criar_pasta',
    '🌐 buscar_na_internet',
    '🔗 acessar_url',
    '💻 executar_comando',
    '🚀 abrir_programa',
    '📦 criar_projeto',
    '🧠 salvar_memoria',
    '🔍 consultar_memoria',
  ];
  
  for (let i = 0; i < toolNames.length && i < chatHeight - 4; i++) {
    moveCursor(5 + i, sidebarCol);
    const name = toolNames[i].padEnd(LAYOUT.sidebarWidth - 4);
    process.stdout.write(`${c.gray}│${c.reset} ${c.dim}${name}${c.reset} ${c.gray}│${c.reset}`);
  }
  
  // Preencher resto
  for (let i = toolNames.length; i < chatHeight - 3; i++) {
    moveCursor(5 + i, sidebarCol);
    process.stdout.write(`${c.gray}│${' '.repeat(LAYOUT.sidebarWidth - 2)}│${c.reset}`);
  }
  
  // Comandos
  const cmdRow = 5 + Math.max(toolNames.length, chatHeight - 6);
  moveCursor(cmdRow, sidebarCol);
  process.stdout.write(`${c.gray}├${'─'.repeat(LAYOUT.sidebarWidth - 2)}┤${c.reset}`);
  
  moveCursor(cmdRow + 1, sidebarCol);
  process.stdout.write(`${c.gray}│${c.reset}${c.bold}${c.yellow} ⌨ COMANDOS ${' '.repeat(LAYOUT.sidebarWidth - 14)}${c.gray}│${c.reset}`);
  
  const cmds = ['/limpar', '/memoria', '/ferramentas', '/sair'];
  for (let i = 0; i < cmds.length; i++) {
    moveCursor(cmdRow + 2 + i, sidebarCol);
    const cmd = cmds[i].padEnd(LAYOUT.sidebarWidth - 4);
    process.stdout.write(`${c.gray}│${c.reset} ${c.dim}${cmd}${c.reset} ${c.gray}│${c.reset}`);
  }
  
  // Borda inferior
  moveCursor(cmdRow + 2 + cmds.length, sidebarCol);
  process.stdout.write(`${c.gray}└${'─'.repeat(LAYOUT.sidebarWidth - 2)}┘${c.reset}`);
}

function drawStatusBar(message = '') {
  const { cols, rows } = getTerminalSize();
  const statusRow = rows - 1;
  
  moveCursor(statusRow, 1);
  process.stdout.write(`${c.bgBlue}${c.white} 🧑 Digite sua mensagem... ${' '.repeat(Math.max(0, cols - 30))}${c.reset}`);
}

function drawLayout() {
  clearScreen();
  drawHeader();
  drawSidebar();
}

// ============ ESTADO LOCAL DO CLI ============
let conversationHistory = [];

// Variáveis de inicialização (serão usadas após conectar ao LM Studio)
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PASTA_PROJETOS = path.join(__dirname, 'projetos_ia');
const ARQUIVO_MEMORIA = path.join(__dirname, 'memoria.json');

// Callback pra mostrar cada tool call na tela, chamado pelo agenteLoop compartilhado
function aoChamarTool(funcName, funcArgs, status, resultado) {
  if (funcName === 'planejamento') {
    process.stdout.write(`\n  ${c.magenta}📋${c.reset} ${c.bold}Plano:${c.reset}\n${c.dim}${resultado}${c.reset}\n`);
    return;
  }
  if (status === 'running') {
    const argsCurto = JSON.stringify(funcArgs).substring(0, 50);
    process.stdout.write(`\n  ${c.yellow}⚡${c.reset} ${c.bold}${funcName}${c.reset}${c.gray}(${argsCurto})${c.reset}`);
    process.stdout.write(`\n    ${c.dim}→ Executando...${c.reset}`);
  } else {
    process.stdout.write(`\r    ${' '.repeat(60)}\r`);
    process.stdout.write(`  ${c.green}✓${c.reset} ${c.dim}${resultado.substring(0, 70)}${c.reset}`);
  }
}

// Callback pro indicador de "pensando/processando/planejando", chamado pelo agenteLoop compartilhado
function aoPensar(fase) {
  const textos = { pensando: 'Pensando...', processando: 'Processando...', planejando: 'Planejando antes de escrever o código...' };
  process.stdout.write(`\n  ${c.cyan}⠋${c.reset} ${c.dim}${textos[fase] || 'Processando...'}${c.reset}`);
}

// ============ INTERFACE ============
function formatResponse(text) {
  // Formatar código
  text = text.replace(/```(\w*)\n([\s\S]*?)```/g, (match, lang, code) => {
    return `\n  ${c.bgBlue}${c.white} ${lang || 'code'} ${c.reset}\n${code.split('\n').map(l => `  ${c.dim}│${c.reset} ${l}`).join('\n')}\n`;
  });
  // Inline code
  text = text.replace(/`([^`]+)`/g, `${c.cyan}$1${c.reset}`);
  // Bold
  text = text.replace(/\*\*(.+?)\*\*/g, `${c.bold}$1${c.reset}`);
  
  return text;
}

async function main() {
  try {
    // ============ 1º: VERIFICAR CONEXÃO COM LM STUDIO ============
    try {
      const res = await fetch(LM_STUDIO_BASE + '/v1/models', { headers: getHeaders() });
      if (!res.ok) throw new Error();
      const data = await res.json();
      const models = data.data || [];
      
      // Conectado com sucesso, continua para criar arquivos...
    } catch (erro) {
      clearScreen();
      console.log(`\n${c.red}✗ ERRO: LM Studio não conectado${c.reset}`);
      console.log(`${c.dim}URL configurada: ${LM_STUDIO_BASE}${c.reset}`);
      console.log(`${c.dim}Verifique se o servidor local do LM Studio está ativo${c.reset}`);
      console.log(`\n${c.yellow}Pressione Enter para sair...${c.reset}`);
      await new Promise(resolve => process.stdin.once('data', resolve));
      process.exit(1);
    }

    // ============ 2º: VERIFICAR E CRIAR PASTA/ARQUIVO DE MEMÓRIA ============
    if (!fs.existsSync(PASTA_PROJETOS)) {
      fs.mkdirSync(PASTA_PROJETOS, { recursive: true });
    }

    if (!fs.existsSync(ARQUIVO_MEMORIA)) {
      const memoriaInicial = { fatos: [], preferencias: [], projetos: [], notas: [] };
      fs.writeFileSync(ARQUIVO_MEMORIA, JSON.stringify(memoriaInicial, null, 2));
    }

    // ============ 3º: DESENHAR LAYOUT APÓS CRIAR ARQUIVOS ============
    drawLayout();
    const { rows } = getTerminalSize();
    moveCursor(rows, 1);
    process.stdout.write(`${c.dim}  Agente pronto. Digite sua mensagem ou /ajuda${c.reset}`);

    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

    // Confirmação real antes de qualquer comando de terminal rodar. Antes o
    // agente executava PowerShell direto, sem perguntar nada — agora para e
    // espera "s" do usuário antes de seguir.
    setConfirmador((comando) => {
      return new Promise((resolve) => {
        process.stdout.write(`\n\n  ${c.bgRed}${c.white} ⚠ CONFIRMAR COMANDO ${c.reset}\n`);
        process.stdout.write(`  ${c.yellow}${comando}${c.reset}\n`);
        rl.question(`  ${c.bold}Executar? (s/N) ${c.reset}`, (resposta) => {
          resolve(/^s(im)?$/i.test(resposta.trim()));
        });
      });
    });

    const prompt = () => {
      const { rows } = getTerminalSize();
      moveCursor(rows, 1);
      process.stdout.write(`${c.bgBlue}${c.white}${' '.repeat(getTerminalSize().cols)}${c.reset}`);
      moveCursor(rows, 3);
      
      rl.question('', async (input) => {
        const texto = input.trim();
        if (!texto) return prompt();

        // Comandos
        if (texto === '/sair') {
          clearScreen();
          console.log(`\n  ${c.cyan}👋 Até logo!${c.reset}\n`);
          rl.close();
          process.exit(0);
        }
        if (texto === '/limpar') {
          conversationHistory = [];
          drawLayout();
          return prompt();
        }
        if (texto === '/memoria') {
          executeTool('consultar_memoria', { categoria: 'todas' }).then(mem => {
            console.log(`\n\n  ${c.magenta}📝 Memória:${c.reset}\n  ${c.dim}${mem}${c.reset}`);
            return prompt();
          });
          return;
        }
        if (texto === '/ferramentas') {
          console.log(`\n\n  ${c.yellow}🔧 Ferramentas disponíveis:${c.reset}`);
          tools.forEach(t => console.log(`    ${c.cyan}•${c.reset} ${t.function.name}`));
          return prompt();
        }

        // Processar mensagem
        try {
          const resposta = await agenteLoop(texto, conversationHistory, aoChamarTool, aoPensar);
          
          // Mostrar resposta formatada
          console.log(`\n\n  ${c.bgGreen}${c.white} 🤖 Agente ${c.reset}`);
          console.log(`  ${c.dim}─${''.repeat(50)}${c.reset}`);
          const linhas = formatResponse(resposta).split('\n');
          for (const linha of linhas) {
            console.log(`  ${linha}`);
          }
          console.log(`  ${c.dim}─${''.repeat(50)}${c.reset}`);
        } catch (error) {
          console.log(`\n\n  ${c.red}✗ Erro: ${error.message}${c.reset}`);
        }

        prompt();
      });
    };

    prompt();
  } catch (erroGeral) {
    clearScreen();
    console.log(`\n${c.red}✗ ERRO GERAL: ${erroGeral.message}${c.reset}`);
    console.log(`${c.dim}${erroGeral.stack}${c.reset}`);
    console.log(`\n${c.yellow}Pressione Enter para sair...${c.reset}`);
    process.stdin.once('data', () => process.exit(1));
  }
}

// Redimensionamento
process.stdout.on('resize', () => drawLayout());

main();
