import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { parseJson } from './json.js';

// WorkBuddy 的模型配置有两种已知形态：裸数组，或带 models 字段的对象。
// 这里只做形状校验，不解释内容——内容由 merge 阶段按条目决定，用户自己的条目永远不碰。
export async function validateModelsFile(file) {
  if (typeof file !== 'string' || !path.isAbsolute(file) || path.basename(file).toLowerCase() !== 'models.json')
    throw new Error('请选择 WorkBuddy 的 models.json 配置文件');
  const document = parseJson(await fs.readFile(file, 'utf8'));
  if (!Array.isArray(document) && !Array.isArray(document?.models))
    throw new Error('文件不是支持的 WorkBuddy 模型配置格式');
  return file;
}

// 记过的路径或显式指定的路径绝不能悄悄回退到另一个 profile：
// 找不到就返回 null，由调用方决定是报错还是让用户手动选。
export async function resolveModelsFile({ saved, env = process.env, home = os.homedir() } = {}) {
  const file = env.FERRY_MODELS_FILE || saved ||
    path.join(env.WORKBUDDY_CONFIG_DIR?.trim() || path.join(home, env.WORKBUDDY_DATA_FOLDER_NAME?.trim() || '.workbuddy'), 'models.json');
  try { return await validateModelsFile(file); } catch { return null; }
}
