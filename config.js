// ============================================================
// config.js — carrega e valida config.json.
// Separado do agente.js pra evitar import circular com tools.js
// (tools.js precisa do WORKSPACE, agente.js precisa das tools).
// ============================================================
import fs from 'fs';
import path from 'path';

const configPath = path.join(process.cwd(), 'config.json');

function carregarConfig() {
  if (!fs.existsSync(configPath)) {
    throw new Error(
      `config.json não encontrado em ${configPath}.\n` +
      `Crie um arquivo config.json com: { "lmStudioUrl": "...", "model": "...", "workspace": "..." }`
    );
  }
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
  } catch (e) {
    throw new Error(`config.json inválido (não é um JSON válido): ${e.message}`);
  }
  if (!raw.lmStudioUrl) {
    throw new Error('config.json precisa ter o campo "lmStudioUrl" (ex: "http://127.0.0.1:1234").');
  }
  return raw;
}

export const config = carregarConfig();
export const LM_STUDIO_BASE = config.lmStudioUrl.replace(/\/+$/, '');
export const LM_STUDIO_URL = LM_STUDIO_BASE + '/v1/chat/completions';
export const API_TOKEN = config.apiToken || '';
export const MODEL = config.model || 'local-model';
// Workspace agora é configurável — antes estava fixo como "d:\ia local"
// espalhado em vários arquivos. Se você mudar de máquina, só troca aqui (ou no config.json).
export const WORKSPACE = config.workspace || 'd:\\ia local';

export function getHeaders() {
  const headers = { 'Content-Type': 'application/json' };
  if (API_TOKEN) headers['Authorization'] = `Bearer ${API_TOKEN}`;
  return headers;
}
