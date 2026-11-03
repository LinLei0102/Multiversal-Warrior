/**
 * 生成「毕业存档」
 * ---------------------------------------------------------------
 * 以一份真实游玩产生的存档为基底，把资源、树节点、挑战者等级全部拉满，
 * 用来解锁全部界面，做汉化覆盖率自检。
 *
 * 用法：
 *   node tools/make-save.mjs                       # 用 i18n/_build/save-raw.json 作基底
 *   node tools/make-save.mjs --base=path.json      # 指定基底存档
 *   node tools/make-save.mjs --out=saves/graduation.json
 *
 * 产出：saves/graduation.json（可直接用游戏内「从文件导入」加载）
 *
 * 说明：存档载入走 deepMerge，所以缺字段没关系；这里只覆盖需要放大的部分。
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const arg = (name, def) => {
  const hit = process.argv.slice(2).find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : def;
};

const BASE = path.resolve(ROOT, arg('base', 'i18n/_build/save-raw.json'));
const OUT = path.resolve(ROOT, arg('out', 'saves/graduation.json'));

const BIG = '1e40';          // 资源量级
const save = JSON.parse(fs.readFileSync(BASE, 'utf8'));

const isNumStr = (v) => typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v));

/* 1. 资源类字段（白名单）：只放大真正的货币，别碰 *R / *Size / *Sel 这类结构字段，
      否则游戏会按「1e40 个格子」去循环并把每帧都刷爆 */
const RESOURCES = [
  'size', 'heat', 'fireShards', 'fire', 'wood', 'coal', 'magma', 'light', 'rotation',
  'water', 'elisir', 'ambrosia', 'erbs', 'fluidFire', 'waterGem', 'pyroFrost',
  'intent', 'origin', 'sacredEnergy', 'nobility', 'divinity',
  'earth', 'golem', 'iron', 'silver', 'obsidian', 'mithril',
  'ironGolem', 'silverGolem', 'obsidianGolem', 'Uron', 'celesteDust', 'skyDust',
  'wind', 'ore', 'metal', 'soul', 'demon', 'ash', 'hellEnergy', 'soulEnergy', 'demonEnergy',
  'fame', 'maxFame', 'fameReq', 'hope', 'maxHope', 'hopeReq', 'trust', 'maxTrust', 'trustReq',
  'hellPowers1Points', 'hellPowers1PointsMax', 'hellPowers2Points', 'hellPowers2PointsMax',
  'hellPowers3Points', 'hellPowers3PointsMax',
  'massaConfusa', 'primaMateria',
];

for (const key of RESOURCES) {
  const v = save.IUniversal[key];
  if (isNumStr(v)) save.IUniversal[key] = BIG;
  else if (typeof v === 'number') save.IUniversal[key] = 9999;
}

/* 2. 宇宙进度给一个「能看到后期界面」的合理值 */
save.IUniversal.universe = '150';
save.IUniversal.tier = '10';
save.IUniversal.ascensionPoint = 5000;
save.IUniversal.ascensionPointMax = '5000';

/* 3. 五棵树：把每个节点点亮到 10 级 */
for (const treeName of ['fireTree', 'waterTree', 'earthTree', 'windTree', 'metalTree']) {
  const tree = save.IUniversal[treeName];
  if (!tree) continue;
  for (const nodeId of Object.keys(tree)) {
    const node = tree[nodeId];
    if (!node || typeof node !== 'object' || Array.isArray(node)) continue;
    if ('active' in node) node.active = true;
    if ('unlocked' in node) node.unlocked = true;
    if ('click' in node) node.click = true;
    if ('level' in node) node.level = '10';
    if ('timer' in node && isNumStr(node.timer)) node.timer = '10';
  }
}

/* 4. 自动化全部解锁（但不自动开启，避免跑飞） */
for (const key of Object.keys(save.IUniversal.automation || {})) {
  const a = save.IUniversal.automation[key];
  if (a && typeof a === 'object' && 'unlocked' in a) a.unlocked = true;
}

/* 5. 挑战者 / 训练 */
save.IFight.challengers.baseChallenger.level = '500';
if (save.IFight.challengers.universalChallenger) {
  save.IFight.challengers.universalChallenger.level = 500;
}
for (const key of Object.keys(save.ITraining.base || {})) {
  const t = save.ITraining.base[key];
  if (!t) continue;
  t.level = '100';
  t.tot = BIG;
}

/* 6. 主资源与宇宙挑战者货币 */
save.IGameData.power = BIG;
save.IGameData.essence = BIG;
for (const key of Object.keys(save.IUniversalChallenger)) {
  const v = save.IUniversalChallenger[key];
  if (isNumStr(v)) save.IUniversalChallenger[key] = BIG;
}

/* 7. 训练升级组：把可购买上限放开 */
for (const g of Object.keys(save.ISelUpgrade.group || {})) {
  const group = save.ISelUpgrade.group[g];
  for (const itemKey of Object.keys(group || {})) {
    const item = group[itemKey];
    if (item && typeof item === 'object') {
      if ('maxNum' in item) item.maxNum = 10;
      if ('level' in item && isNumStr(item.level)) item.level = '10';
    }
  }
}

/* 8. 预置拖拽网格（8 列 × 20 行）
      正常游戏里格子是玩家第一次拖动时才逐个创建的，直接跳到后期会让渲染循环
      在 inventory[cellKey] / treasureInventory[cellKey] 上读到 undefined 并每帧报错。 */
const COLS = 8;
const ROWS = 20;
const GRIDS = ['inventory', 'treasureInventory'];
for (const gridName of GRIDS) {
  save.IUniversal[gridName] = save.IUniversal[gridName] || {};
  for (let y = 1; y <= ROWS; y++) {
    for (let x = 1; x <= COLS; x++) {
      const cellKey = `c${y}r${x}`;
      if (!save.IUniversal[gridName][cellKey]) {
        save.IUniversal[gridName][cellKey] = { key: null, pX: x, pY: y, amount: 1, drag: gridName };
      }
    }
  }
}

/* 9. 子系统：远征 / 宝物 / 熔炉 / 矿场
      这些界面的解锁条件各不相同（例如矿场要求 expeditions.exp10.level >= 1），
      逐个点亮才能把后期面板真正渲染出来。 */
const patchChildren = (obj, patch) => {
  for (const key of Object.keys(obj || {})) {
    const item = obj[key];
    if (item && typeof item === 'object' && !Array.isArray(item)) Object.assign(item, patch(item));
  }
};

patchChildren(save.IUniversal.expeditions, () => ({ level: '1' }));
patchChildren(save.IUniversal.treasures, () => ({ active: true, level: 1, num: 1 }));
patchChildren(save.IUniversal.forge, () => ({ unlocked: true, level: '1' }));
patchChildren(save.IUniversal.mine, () => ({ unlocked: true, level: '1' }));
patchChildren(save.IUniversal.spires, () => ({ active: true, level: '1' }));

/* 狩猎：解锁全部猎物并升到 10 级，否则「狩猎奖励」整块不渲染（req() 不满足） */
patchChildren(save.IFight.normalHunting, () => ({ unlocked: true, level: '10' }));
patchChildren(save.IFight.normalHuntingRewards, () => ({ unlocked: true, level: '1' }));
patchChildren(save.IFight.huntingMulti, () => ({ unlocked: true }));
for (const groupKey of ['treasureFormation', 'treasureArmy', 'treasureEquipment', 'treasureAugments', 'treasureUpgrade', 'potionUpgrade', 'potionAutoUpgrade', 'potionSource', 'potionFusion', 'coreItem', 'equipment', 'golemTypes', 'armyLoadout', 'energyUpgrades']) {
  patchChildren(save.IUniversal[groupKey], () => ({ unlocked: true }));
}

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, JSON.stringify(save), 'utf8');

const nodes = Object.keys(save.IUniversal.fireTree || {}).length;
console.log(`基底存档：${path.relative(ROOT, BASE)}`);
console.log(`输出存档：${path.relative(ROOT, OUT)}（${(fs.statSync(OUT).size / 1024).toFixed(0)} KB）`);
console.log(`宇宙=${save.IUniversal.universe}  挑战者等级=${save.IFight.challengers.baseChallenger.level}  火树节点=${nodes}`);
