// ============================================================
// estado.js — Gerenciamento de estado persistente dos projetos
// ============================================================
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const ESTADO_DIR = path.join(__dirname, '.estado_projetos');
const PROJETOS_DIR = path.join(__dirname, 'projetos_ia');

// Garantir que as pastas existem
if (!fs.existsSync(ESTADO_DIR)) {
  fs.mkdirSync(ESTADO_DIR, { recursive: true });
}
if (!fs.existsSync(PROJETOS_DIR)) {
  fs.mkdirSync(PROJETOS_DIR, { recursive: true });
}

// Estrutura de um projeto em andamento
// {
//   projeto: string (nome),
//   chave: string (identificador único),
//   criadoEm: number (timestamp),
//   atualizadoEm: number (timestamp),
//   etapaAtual: number (índice da etapa atual, 0-based),
//   etapas: [{ id, caminho, descricao, status }],
//   logica: string,
//   resultadoEsperado: string,
//   tamanho?: string,
//   decicoes: [{ timestamp, texto }],
//   abandonado: boolean
// }

function gerarChave(nome) {
  return `${nome.toLowerCase().replace(/[^a-z0-9]/g, '_')}_${Date.now()}`;
}

function getArquivoEstado(chave) {
  return path.join(ESTADO_DIR, `${chave}.json`);
}

function salvarProjeto(projeto) {
  projeto.atualizadoEm = Date.now();
  const arquivo = getArquivoEstado(projeto.chave);
  fs.writeFileSync(arquivo, JSON.stringify(projeto, null, 2));
}

function carregarProjeto(nomeOuChave) {
  // Tenta encontrar por nome ou chave
  if (!fs.existsSync(ESTADO_DIR)) return null;
  
  const arquivos = fs.readdirSync(ESTADO_DIR);
  for (const arquivo of arquivos) {
    if (!arquivo.endsWith('.json')) continue;
    try {
      const projeto = JSON.parse(fs.readFileSync(path.join(ESTADO_DIR, arquivo), 'utf8'));
      if (projeto.projeto === nomeOuChave || projeto.chave === nomeOuChave) {
        return projeto;
      }
    } catch {
      // Arquivo corrompido, ignora
    }
  }
  return null;
}

function criarProjeto(nome, pedidoUsuario, arquivosComDescricao, logica, resultadoEsperado, tamanho, tipo) {
  const chave = gerarChave(nome);
  const etapas = arquivosComDescricao.map((arq, idx) => ({
    id: `etapa_${idx + 1}`,
    caminho: arq.caminho,
    descricao: arq.descricao,
    status: 'pendente'
  }));
  
  const projeto = {
    projeto: nome,
    chave,
    criadoEm: Date.now(),
    atualizadoEm: Date.now(),
    etapaAtual: 0,
    etapas,
    logica,
    resultadoEsperado,
    tamanho: tamanho || undefined,
    tipo: tipo || undefined,
    decicoes: [],
    abandonado: false
  };
  
  salvarProjeto(projeto);
  return projeto;
}

function registrarDecisao(projeto, texto) {
  if (!projeto.decicoes) projeto.decicoes = [];
  projeto.decicoes.push({ timestamp: Date.now(), texto });
  salvarProjeto(projeto);
}

function registrarErro(projeto, idEtapa, erro) {
  const etapa = projeto.etapas.find(e => e.id === idEtapa);
  if (etapa) {
    etapa.status = 'erro';
    etapa.erro = erro;
  }
  salvarProjeto(projeto);
}

function marcarEtapaConcluida(projeto, idEtapa) {
  const etapa = projeto.etapas.find(e => e.id === idEtapa);
  if (etapa) {
    etapa.status = 'concluida';
    projeto.etapaAtual++;
  }
  salvarProjeto(projeto);
}

function etapasPendentes(projeto) {
  return projeto.etapas.filter(e => e.status === 'pendente');
}

function projetoEmAndamentoUnico() {
  if (!fs.existsSync(ESTADO_DIR)) return null;
  
  const arquivos = fs.readdirSync(ESTADO_DIR);
  let projetoPendente = null;
  
  for (const arquivo of arquivos) {
    if (!arquivo.endsWith('.json')) continue;
    try {
      const projeto = JSON.parse(fs.readFileSync(path.join(ESTADO_DIR, arquivo), 'utf8'));
      if (!projeto.abandonado && projeto.etapaAtual < projeto.etapas.length) {
        // Verifica se ainda há etapas pendentes
        const pendentes = projeto.etapas.filter(e => e.status === 'pendente');
        if (pendentes.length > 0) {
          projetoPendente = projeto;
          break; // Retorna o primeiro encontrado
        }
      }
    } catch {
      // Arquivo corrompido, ignora
    }
  }
  
  return projetoPendente;
}

function resumoProjeto(projeto) {
  const total = projeto.etapas.length;
  const concluidas = projeto.etapas.filter(e => e.status === 'concluida').length;
  const erros = projeto.etapas.filter(e => e.status === 'erro').length;
  const pendentes = total - concluidas - erros;
  
  let resumo = `Projeto: ${projeto.projeto}\n`;
  resumo += `Progresso: ${concluidas}/${total} etapas concluídas`;
  if (erros > 0) resumo += `, ${erros} com erro`;
  if (pendentes > 0) resumo += `, ${pendentes} pendentes`;
  resumo += `\nPróxima etapa: ${projeto.etapaAtual + 1} de ${total}`;
  
  if (projeto.etapas[projeto.etapaAtual]) {
    const proxima = projeto.etapas[projeto.etapaAtual];
    resumo += `\nArquivo: ${proxima.caminho}`;
    resumo += `\nDescrição: ${proxima.descricao}`;
  }
  
  if (projeto.logica) {
    resumo += `\n\nLógica do projeto:\n${projeto.logica}`;
  }
  
  if (projeto.resultadoEsperado) {
    resumo += `\n\nResultado esperado:\n${projeto.resultadoEsperado}`;
  }
  
  return resumo;
}

function marcarAbandonado(projeto) {
  projeto.abandonado = true;
  salvarProjeto(projeto);
}

function listarProjetosEmAndamento() {
  if (!fs.existsSync(ESTADO_DIR)) return [];
  
  const projetos = [];
  const arquivos = fs.readdirSync(ESTADO_DIR);
  
  for (const arquivo of arquivos) {
    if (!arquivo.endsWith('.json')) continue;
    try {
      const projeto = JSON.parse(fs.readFileSync(path.join(ESTADO_DIR, arquivo), 'utf8'));
      if (!projeto.abandonado && projeto.etapaAtual < projeto.etapas.length) {
        const pendentes = projeto.etapas.filter(e => e.status === 'pendente');
        if (pendentes.length > 0) {
          projetos.push({
            nome: projeto.projeto,
            chave: projeto.chave,
            etapaAtual: projeto.etapaAtual,
            totalEtapas: projeto.etapas.length,
            criadoEm: projeto.criadoEm
          });
        }
      }
    } catch {
      // Arquivo corrompido, ignora
    }
  }
  
  return projetos.sort((a, b) => b.criadoEm - a.criadoEm);
}

function adicionarEtapas(projeto, novasEtapas) {
  const offset = projeto.etapas.length;
  const etapasAdicionadas = novasEtapas.map((arq, idx) => ({
    id: `etapa_${offset + idx + 1}`,
    caminho: arq.caminho,
    descricao: arq.descricao,
    status: 'pendente'
  }));
  
  projeto.etapas.push(...etapasAdicionadas);
  salvarProjeto(projeto);
  
  return etapasAdicionadas;
}

export {
  criarProjeto,
  carregarProjeto,
  salvarProjeto,
  registrarDecisao,
  registrarErro,
  marcarEtapaConcluida,
  etapasPendentes,
  projetoEmAndamentoUnico,
  resumoProjeto,
  marcarAbandonado,
  listarProjetosEmAndamento,
  adicionarEtapas
};
