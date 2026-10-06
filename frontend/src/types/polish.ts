/**
 * 打磨推光（Polish）数据模型
 * 按道次登记的磨料目数与手法时长，未打磨完不许进入下一道罩漆。
 * 同一道常需补磨一遍：每条记录可补记一次补磨，此后各页面一律按补磨后的目数计算。
 */

/** 手法：水砂 / 推光 / 揩清 */
export type PolishMethod = 'water' | 'burnish' | 'wipe';

/** 补磨子记录：同一道的第二次打磨，每条打磨记录最多补记一次 */
export interface PolishRework {
  /** 补磨日期 yyyy-MM-dd */
  date: string;
  /** 补磨目数 */
  grit: number;
  /** 补磨操作人 */
  operator: string;
  /** 补磨登记时间戳（事后改补磨内容时保留原登记时间） */
  at: number;
}

export type PolishReworkDraft = Omit<PolishRework, 'at'>;

export interface Polish {
  id: string;
  /** 所属胎体 id */
  bodyId: string;
  /** 关联的髹涂道次序号 */
  seq: number;
  /** 磨料目数，如 400 / 800 / 1500 / 2000 */
  grit: number;
  /** 手法 */
  method: PolishMethod;
  /** 耗时（分钟） */
  durationMin: number;
  /** 操作人 */
  operator: string;
  /** 补磨记录；null 表示未补磨，仍按原记录算 */
  rework: PolishRework | null;
  createdAt: number;
  updatedAt: number;
}

export type PolishDraft = Omit<Polish, 'id' | 'createdAt' | 'updatedAt'>;

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

/** 标准目数序列：按道次生成打磨序列时使用 */
export const GRIT_SEQUENCE: readonly number[] = [320, 600, 1000, 1500, 2000];

/** 按道次序号给出建议目数 */
export function suggestGrit(seq: number): number {
  const index = Math.min(Math.max(seq, 1), GRIT_SEQUENCE.length) - 1;
  return GRIT_SEQUENCE[index] ?? 1000;
}

/** 有效目数：补磨过的按补磨目数算，没补磨的按原记录算 */
export function effectiveGrit(polish: Pick<Polish, 'grit' | 'rework'>): number {
  return polish.rework ? polish.rework.grit : polish.grit;
}

/** 补磨目数比原记录粗 → 返工待确认 */
export function isReworkCoarser(polish: Pick<Polish, 'grit' | 'rework'>): boolean {
  return polish.rework ? polish.rework.grit < polish.grit : false;
}

/** 单条记录算不算磨到位：有效目数达到该道次建议目数，且补磨没有越磨越粗 */
export function isPolishSettled(polish: Polish): boolean {
  return !isReworkCoarser(polish) && effectiveGrit(polish) >= suggestGrit(polish.seq);
}

/** 一个道次的打磨结论：汇总该道次全部打磨记录，补磨优先 */
export interface SeqPolishSummary {
  seq: number;
  /** 该道次打磨记录条数 */
  rowCount: number;
  /** 有效目数最高值（补磨后的数） */
  maxGrit: number;
  /** 是否存在补磨目数比原记录粗的「返工待确认」记录 */
  needConfirm: boolean;
  /** 这道算不算磨到位：有记录、无返工待确认、最高有效目数达标 */
  settled: boolean;
}

export function summarizeSeqPolish(seq: number, rows: Polish[]): SeqPolishSummary {
  const list = rows.filter((row) => row.seq === seq);
  const maxGrit = list.reduce((max, row) => Math.max(max, effectiveGrit(row)), 0);
  const needConfirm = list.some((row) => isReworkCoarser(row));
  return {
    seq,
    rowCount: list.length,
    maxGrit,
    needConfirm,
    settled: list.length > 0 && !needConfirm && maxGrit >= suggestGrit(seq),
  };
}

export function createEmptyPolishDraft(bodyId: string, seq: number): PolishDraft {
  return {
    bodyId,
    seq,
    grit: suggestGrit(seq),
    method: 'water',
    durationMin: 30,
    operator: '',
    rework: null,
  };
}

/** 补磨表单初值：默认沿用原记录的目数与操作人，日期取当天 */
export function createEmptyReworkDraft(fallbackGrit: number, fallbackOperator: string): PolishReworkDraft {
  return {
    date: new Date().toISOString().slice(0, 10),
    grit: fallbackGrit,
    operator: fallbackOperator,
  };
}
