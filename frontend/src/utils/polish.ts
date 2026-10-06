/**
 * 打磨派生计算
 *
 * 两种做法在道次页上要能看出差别：
 * - 「按现有记录重算、当场翻盘」：effectivePolishOfSeq() 每次由当前打磨记录实时计算，
 *   补磨被改、被撤后结论立即跟着变；
 * - 「补磨当时写进道次、之后不再回头」：buildPolishStamp() 在补磨登记/放行当时
 *   把结论盖到 Coat.polishStamp 上，事后保持不动。
 * 道次页同时展示两者，不一致即为翻盘差异。
 */
import type { CoatPolishStamp } from '@/types/coat';
import {
  effectiveDate,
  effectiveGrit,
  effectiveOperator,
  isReworkPending,
  polishVerdict,
  type Polish,
  type PolishVerdict,
} from '@/types/polish';

/** 某道在现有记录下算数的打磨结论（多条记录取实际目数最高的一条） */
export interface EffectivePolish {
  /** 算数的目数（有补磨用补磨后目数） */
  grit: number;
  /** 磨到位 / 返工待确认：任一记录补磨得更粗即待确认 */
  verdict: PolishVerdict;
  /** 操作人（取算数目数那条记录） */
  operator: string;
  /** 日期（补磨日期优先） */
  date: string | null;
  /** 该道是否存在打磨记录 */
  exists: boolean;
}

const EMPTY_EFFECTIVE: EffectivePolish = {
  grit: 0,
  verdict: 'done',
  operator: '',
  date: null,
  exists: false,
};

/** 同一道可能登记多条打磨记录，取补磨后实际目数最高的一条算数；补磨更粗的记录标返工待确认 */
export function effectivePolishOfSeq(rows: Polish[], seq: number): EffectivePolish {
  const sameSeq = rows.filter((row) => row.seq === seq);
  if (sameSeq.length === 0) return { ...EMPTY_EFFECTIVE };

  let top = sameSeq[0] as Polish;
  for (const row of sameSeq.slice(1)) {
    if (effectiveGrit(row) > effectiveGrit(top)) top = row;
  }

  const anyReworkPending = sameSeq.some((row) => isReworkPending(row));
  return {
    grit: effectiveGrit(top),
    verdict: anyReworkPending ? 'reworkPending' : polishVerdict(top),
    operator: effectiveOperator(top),
    date: effectiveDate(top),
    exists: true,
  };
}

/** 全胎体：道次序号 → 算数结论 */
export function effectivePolishBySeq(rows: Polish[]): Map<number, EffectivePolish> {
  const map = new Map<number, EffectivePolish>();
  const seqs = new Set(rows.map((row) => row.seq));
  seqs.forEach((seq) => map.set(seq, effectivePolishOfSeq(rows, seq)));
  return map;
}

/** 打磨页顶部「最高目数」：按补磨后的实际目数统计 */
export function maxEffectiveGrit(rows: Polish[]): number {
  return rows.reduce((max, row) => Math.max(max, effectiveGrit(row)), 0);
}

/**
 * 按现有记录给某道盖打磨结论留档戳（补磨登记 / 放行当时调用）。
 * @param source touchUp：补磨登记时盖戳；finish：完成打磨放行时盖戳
 */
export function buildPolishStamp(
  rows: Polish[],
  seq: number,
  source: CoatPolishStamp['source'],
  now: number = Date.now(),
): CoatPolishStamp | null {
  const effective = effectivePolishOfSeq(rows, seq);
  if (!effective.exists) return null;
  return {
    grit: effective.grit,
    verdict: effective.verdict,
    operator: effective.operator,
    date: effective.date,
    source,
    stampedAt: now,
  };
}

/** 实时结论与道次留档是否已翻盘（目数或结论任一不同） */
export function isStampStale(stamp: CoatPolishStamp | null, effective: EffectivePolish): boolean {
  if (!stamp || !effective.exists) return false;
  return stamp.grit !== effective.grit || stamp.verdict !== effective.verdict;
}
