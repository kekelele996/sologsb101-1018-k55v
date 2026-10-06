/**
 * <StageTag> 阶段标签
 * 按胎体状态（待髹涂/髹涂中/待荫干/已完成）与道次状态（待涂/已涂/待打磨/已完成）渲染底色，
 * 并支持荫房异常回写的「待复检」提示；被胎体页、道次页、打磨页消费。
 *
 * 打磨相关追加展示（道次页 / 打磨页）：
 * - grit：该道按补磨后实际目数算数的最高目数
 * - polishPending：补磨目数比原记录粗，返工待确认
 */
import { Tag, Tooltip } from 'antd';
import { ExclamationCircleOutlined, RedoOutlined } from '@ant-design/icons';
import { BODY_STATE_COLOR, BODY_STATE_LABEL, type BodyState } from '@/types/body';
import { COAT_STATE_COLOR, COAT_STATE_LABEL, type CoatState } from '@/types/coat';

export type StageKey = BodyState | CoatState;

export interface StageTagProps {
  /** 状态键：胎体状态或道次状态 */
  state: StageKey;
  /** 是否需要复检（荫房温湿度越界后回写） */
  needRecheck?: boolean;
  /** 道次序号，传入时前缀显示「第 n 道」 */
  seq?: number;
  /** 追加文案，如「已完成 2/4」 */
  suffix?: string;
  /** 该道算数的打磨目数（有补磨按补磨后目数），传入时追加目数标签 */
  grit?: number;
  /** 补磨目数比原记录粗 → 返工待确认 */
  polishPending?: boolean;
}

const LABEL: Record<string, string> = { ...BODY_STATE_LABEL, ...COAT_STATE_LABEL };
const COLOR: Record<string, string> = { ...BODY_STATE_COLOR, ...COAT_STATE_COLOR };

export function StageTag({ state, needRecheck = false, seq, suffix, grit, polishPending = false }: StageTagProps) {
  const label = LABEL[state] ?? state;
  const color = COLOR[state] ?? '#8c8c8c';
  const text = `${seq === undefined ? '' : `第 ${seq} 道 · `}${label}${suffix ? ` · ${suffix}` : ''}`;

  return (
    <>
      <Tag color={color} style={{ marginInlineEnd: needRecheck || grit ? 4 : 0 }}>
        {text}
      </Tag>
      {grit ? (
        <Tooltip title="该道算数的打磨目数（有补磨按补磨后的数）">
          <Tag color={polishPending ? 'default' : 'gold'} style={{ marginInlineEnd: polishPending ? 4 : 0 }}>
            {grit} 目
          </Tag>
        </Tooltip>
      ) : null}
      {polishPending ? (
        <Tooltip title="补磨目数比原记录粗（回粗砂返工），需负责人确认后才能放行">
          <Tag icon={<RedoOutlined />} color="error">
            返工待确认
          </Tag>
        </Tooltip>
      ) : null}
      {needRecheck ? (
        <Tooltip title="关联荫房温湿度越界，需复检漆层">
          <Tag icon={<ExclamationCircleOutlined />} color="warning">
            待复检
          </Tag>
        </Tooltip>
      ) : null}
    </>
  );
}

export default StageTag;
