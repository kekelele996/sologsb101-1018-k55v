/**
 * 打磨推光（Polish）数据模型
 * 按道次登记的磨料目数与手法时长，未打磨完不许进入下一道罩漆。
 *
 * 返工打磨常见：同一道先粗磨一遍，过几天看出花印再补磨一遍。
 * 每条打磨记录允许「补记一次补磨」（touchUp）：没有补磨时按原记录算，
 * 有补磨时这道算不算磨到位、打磨页顶部最高目数、道次页阶段标签都改用补磨后的数；
 * 补磨目数比原记录粗（目数更小）的，判为「返工待确认」。
 */

/** 手法：水砂 / 推光 / 揩清 */
export type PolishMethod = 'water' | 'burnish' | 'wipe';

/** 补磨记录：每条原打磨至多补记一次 */
export interface PolishTouchUp {
  /** 补磨日期 yyyy-MM-dd */
  date: string;
  /** 补磨目数，如 600 / 1000 / 2000 */
  grit: number;
  /** 补磨操作人 */
  operator: string;
}

export interface Polish {
  id: string;
  /** 所属胎体 id */
  bodyId: string;
  /** 关联的髹涂道次序号 */
  seq: number;
  /** 磨料目数，如 400 / 800 / 1500 / 2000（原记录目数） */
  grit: number;
  /** 手法 */
  method: PolishMethod;
  /** 耗时（分钟） */
  durationMin: number;
  /** 操作人 */
  operator: string;
  /** 补磨记录：null 表示未补磨，按原记录算 */
  touchUp: PolishTouchUp | null;
  createdAt: number;
  updatedAt: number;
}

export type PolishDraft = Omit<Polish, 'id' | 'createdAt' | 'updatedAt'>;

/** 补磨登记草稿 */
export type PolishTouchUpDraft = PolishTouchUp;

export const POLISH_METHOD_LABEL: Record<PolishMethod, string> = {
  water: '水砂',
  burnish: '推光',
  wipe: '揩清',
};

export const POLISH_METHOD_COLOR: Record<PolishMethod, string> = {
  water: '#3a6ea5',
  burnish: '#c9963c',
  wipe: '#2f6f4f',
};

export const POLISH_METHOD_OPTIONS: ReadonlyArray<{ value: PolishMethod; label: string }> = [
  { value: 'water', label: '水砂' },
  { value: 'burnish', label: '推光' },
  { value: 'wipe', label: '揩清' },
];

/** 打磨结论：已到位 / 返工待确认 */
export type PolishVerdict = 'done' | 'reworkPending';

export const POLISH_VERDICT_LABEL: Record<PolishVerdict, string> = {
  done: '磨到位',
  reworkPending: '返工待确认',
};

/** 标准目数序列：按道次生成打磨序列时使用 */
export const GRIT_SEQUENCE: readonly number[] = [320, 600, 1000, 1500, 2000];

/** 按道次序号给出建议目数 */
export function suggestGrit(seq: number): number {
  const index = Math.min(Math.max(seq, 1), GRIT_SEQUENCE.length) - 1;
  return GRIT_SEQUENCE[index] ?? 1000;
}

/** 实际算数的目数：有补磨用补磨目数，否则用原记录目数 */
export function effectiveGrit(row: Pick<Polish, 'grit' | 'touchUp'>): number {
  return row.touchUp ? row.touchUp.grit : row.grit;
}

/** 实际算数的操作人：有补磨用补磨操作人 */
export function effectiveOperator(row: Pick<Polish, 'operator' | 'touchUp'>): string {
  return row.touchUp ? row.touchUp.operator : row.operator;
}

/** 实际算数的日期：补磨日期 / null（原记录无日期字段） */
export function effectiveDate(row: Pick<Polish, 'touchUp'>): string | null {
  return row.touchUp ? row.touchUp.date : null;
}

/** 补磨目数比原记录粗（目数更小）→ 返工待确认；未补磨或更细视为到位 */
export function isReworkPending(row: Pick<Polish, 'grit' | 'touchUp'>): boolean {
  return row.touchUp !== null && row.touchUp.grit < row.grit;
}

export function polishVerdict(row: Pick<Polish, 'grit' | 'touchUp'>): PolishVerdict {
  return isReworkPending(row) ? 'reworkPending' : 'done';
}

export function createEmptyPolishDraft(bodyId: string, seq: number): PolishDraft {
  return {
    bodyId,
    seq,
    grit: suggestGrit(seq),
    method: 'water',
    durationMin: 30,
    operator: '',
    touchUp: null,
  };
}

export function createEmptyTouchUpDraft(originalGrit: number): PolishTouchUpDraft {
  return {
    date: new Date().toISOString().slice(0, 10),
    // 默认建议比原记录更细一档（目数更大）
    grit: nextFinerGrit(originalGrit),
    operator: '',
  };
}

/** 取标准序列中比原目数更细的下一挡；已是最细则保持原目数 */
export function nextFinerGrit(grit: number): number {
  const finer = GRIT_SEQUENCE.find((value) => value > grit);
  return finer ?? grit;
}
