/**
 * /polish 打磨与推光工序录入
 * 按道次生成目数序列，未打磨完的道次禁止进入下一道罩漆。
 *
 * 返工补磨：每条打磨记录可补记一次补磨（补磨日期 / 目数 / 操作人）。
 * - 没补磨的按原记录算；有补磨的，这道算不算磨到位、页顶最高目数、道次页阶段标签都按补磨后的数；
 * - 补磨目数比原记录粗（目数更小）→ 返工待确认，不放行；
 * - 补磨登记当时把结论盖进道次留档（policy「写进道次、不再回头」），
 *   事后补磨被改 / 被撤，留档不动；页上实时结论始终按现有记录重算（policy「当场翻盘」），
 *   两种做法的差别到道次页并排查看。
 * 消费 Polish、Coat；复用 <StageTag>、<StatBadge>、<EmptyPanel>。
 */
import { useMemo, useState } from 'react';
import {
  Alert,
  App as AntdApp,
  Button,
  Card,
  DatePicker,
  Form,
  Input,
  InputNumber,
  Modal,
  Popconfirm,
  Select,
  Space,
  Table,
  Tag,
  Tooltip,
  Typography,
} from 'antd';
import type { ColumnsType } from 'antd/es/table';
import dayjs from 'dayjs';
import { DeleteOutlined, EditOutlined, PlusOutlined, RedoOutlined, ThunderboltOutlined, UndoOutlined } from '@ant-design/icons';
import EmptyPanel from '@/components/common/EmptyPanel';
import StatBadge from '@/components/common/StatBadge';
import StageTag from '@/components/common/StageTag';
import { useCoatProgress } from '@/hooks/useCoatProgress';
import { useIdbTable } from '@/hooks/useIdbTable';
import { useBodyStore } from '@/stores/bodyStore';
import { useCoatStore } from '@/stores/coatStore';
import { buildPolishStamp, maxEffectiveGrit } from '@/utils/polish';
import {
  GRIT_SEQUENCE,
  POLISH_METHOD_COLOR,
  POLISH_METHOD_LABEL,
  POLISH_METHOD_OPTIONS,
  createEmptyPolishDraft,
  createEmptyTouchUpDraft,
  effectiveGrit,
  effectiveOperator,
  isReworkPending,
  suggestGrit,
  type Polish,
  type PolishDraft,
  type PolishMethod,
  type PolishTouchUp,
  type PolishTouchUpDraft,
} from '@/types/polish';
import { BODY_SHAPE_LABEL } from '@/types/body';

export default function PolishBoard() {
  const { message } = AntdApp.useApp();
  const [form] = Form.useForm<PolishDraft>();
  const [touchForm] = Form.useForm<PolishTouchUpDraft>();
  const polishTable = useIdbTable<Polish>((database) => database.polishes, { sortByUpdatedAt: false });

  const bodies = useBodyStore((state) => state.bodies);
  const currentBodyId = useBodyStore((state) => state.currentBodyId);
  const setCurrentBodyId = useBodyStore((state) => state.setCurrentBodyId);
  const coats = useCoatStore((state) => state.coats);
  const updateCoat = useCoatStore((state) => state.updateCoat);
  const { progressOf } = useCoatProgress();

  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<Polish | null>(null);
  const [touchTarget, setTouchTarget] = useState<Polish | null>(null);

  const activeBody = bodies.find((body) => body.id === currentBodyId) ?? bodies[0] ?? null;
  const bodyId = activeBody?.id ?? '';

  const bodyCoats = useMemo(
    () => coats.filter((coat) => coat.bodyId === bodyId).sort((a, b) => a.seq - b.seq),
    [coats, bodyId],
  );

  const rows = useMemo(
    () =>
      polishTable.rows
        .filter((row) => row.bodyId === bodyId)
        .sort((a, b) => (a.seq === b.seq ? effectiveGrit(a) - effectiveGrit(b) : a.seq - b.seq)),
    [polishTable.rows, bodyId],
  );

  /** 已涂但尚未打磨的道次：未打磨完禁止进入下一道罩漆 */
  const blocked = useMemo(
    () =>
      bodyCoats.filter(
        (coat) => coat.state === 'toPolish' && !rows.some((row) => row.seq === coat.seq),
      ),
    [bodyCoats, rows],
  );

  /** 补磨回粗砂的记录：返工待确认，髹涂台不得放行 */
  const reworkRows = useMemo(() => rows.filter((row) => isReworkPending(row)), [rows]);
  const reworkSeqs = useMemo(() => Array.from(new Set(reworkRows.map((row) => row.seq))).sort((a, b) => a - b), [reworkRows]);

  const stat = bodyId ? progressOf(bodyId) : null;
  const totalMinutes = rows.reduce((sum, row) => sum + row.durationMin, 0);
  const topGrit = maxEffectiveGrit(rows);

  /** 道次序号 → 该道是否存在返工待确认的打磨记录（阶段标签用） */
  const pendingSeqSet = useMemo(() => new Set(reworkRows.map((row) => row.seq)), [reworkRows]);
  /** 道次序号 → 该道算数目数（补磨后取最高） */
  const seqGritMap = useMemo(() => {
    const map = new Map<number, number>();
    rows.forEach((row) => {
      map.set(row.seq, Math.max(map.get(row.seq) ?? 0, effectiveGrit(row)));
    });
    return map;
  }, [rows]);

  const openCreate = (): void => {
    if (!bodyId) {
      message.warning('请先选择胎体');
      return;
    }
    const nextSeq = bodyCoats.length === 0 ? 1 : Math.max(...bodyCoats.map((coat) => coat.seq));
    setEditing(null);
    form.setFieldsValue(createEmptyPolishDraft(bodyId, nextSeq));
    setOpen(true);
  };

  const openEdit = (row: Polish): void => {
    setEditing(row);
    form.setFieldsValue({
      bodyId: row.bodyId,
      seq: row.seq,
      grit: row.grit,
      method: row.method,
      durationMin: row.durationMin,
      operator: row.operator,
      touchUp: row.touchUp,
    });
    setOpen(true);
  };

  const submit = async (): Promise<void> => {
    const values = await form.validateFields();
    // 原记录编辑不改补磨，也不重盖道次留档（留档只随补磨登记 / 放行动作写）
    const payload: PolishDraft = { ...values, touchUp: editing?.touchUp ?? null };
    if (editing) {
      await polishTable.update(editing.id, payload);
      message.success('已更新打磨记录');
    } else {
      await polishTable.create(payload, 'polish');
      message.success('已新增打磨记录');
    }
    setOpen(false);
  };

  /** 补记 / 编辑补磨弹窗 */
  const openTouchUp = (row: Polish): void => {
    setTouchTarget(row);
    touchForm.setFieldsValue(
      row.touchUp
        ? { date: row.touchUp.date, grit: row.touchUp.grit, operator: row.touchUp.operator }
        : createEmptyTouchUpDraft(row.grit),
    );
  };

  /**
   * 保存补磨：
   * 1) 实时口径——打磨记录更新，页顶最高目数 / 道次阶段标签立即按现有记录重算（当场翻盘）；
   * 2) 留档口径——补磨登记当时把结论盖进道次 polishStamp（写进道次、之后不再回头）。
   */
  const submitTouchUp = async (): Promise<void> => {
    if (!touchTarget) return;
    const values = await touchForm.validateFields();
    const touchUp: PolishTouchUp = { ...values };
    const targetSeq = touchTarget.seq;
    const hadTouchUp = touchTarget.touchUp !== null;

    // 用保存后的记录集合现算盖戳，避免等待 liveQuery 刷新
    const projectedRows = rows.map((row) => (row.id === touchTarget.id ? { ...row, touchUp } : row));
    const stamp = buildPolishStamp(projectedRows, targetSeq, 'touchUp');

    await polishTable.update(touchTarget.id, { touchUp });
    const coat = bodyCoats.find((item) => item.seq === targetSeq);
    if (coat && stamp) {
      await updateCoat(coat.id, { polishStamp: stamp });
    }

    const action = hadTouchUp ? '更新' : '补记';
    message.success(
      touchUp.grit < touchTarget.grit
        ? `已${action}第 ${targetSeq} 道补磨：${touchUp.grit} 目比原记录粗，标为返工待确认`
        : `已${action}第 ${targetSeq} 道补磨，结论改按 ${touchUp.grit} 目算`,
    );
    setTouchTarget(null);
  };

  /** 撤回补磨：实时口径立即回到原记录；道次留档不动，两种做法的差别留在道次页 */
  const withdrawTouchUp = async (row: Polish): Promise<void> => {
    await polishTable.update(row.id, { touchUp: null });
    message.success(`已撤回第 ${row.seq} 道补磨，实时结论按原记录 ${row.grit} 目重算；道次留档保持不动`);
  };

  /** 按道次生成目数序列：为每个尚无打磨记录的道次生成一条建议记录 */
  const generateSequence = async (): Promise<void> => {
    const targets = bodyCoats.filter((coat) => !rows.some((row) => row.seq === coat.seq));
    if (targets.length === 0) {
      message.info('所有道次均已有打磨记录');
      return;
    }
    for (const coat of targets) {
      await polishTable.create(
        {
          bodyId,
          seq: coat.seq,
          grit: suggestGrit(coat.seq),
          method: coat.seq >= 3 ? 'burnish' : 'water',
          durationMin: 30 + coat.seq * 5,
          operator: '',
          touchUp: null,
        },
        'polish',
      );
    }
    message.success(`已按 ${targets.length} 个道次生成目数序列（${GRIT_SEQUENCE.slice(0, targets.length).join(' / ')}）`);
  };

  /** 打磨完成后把道次推进到已完成；返工待确认的道次不得放行 */
  const finishPolish = async (row: Polish): Promise<void> => {
    const coat = bodyCoats.find((item) => item.seq === row.seq);
    if (!coat) {
      message.warning('未找到对应道次');
      return;
    }
    if (pendingSeqSet.has(row.seq)) {
      message.warning(`第 ${row.seq} 道补磨目数比原记录粗，返工待确认，不能放行`);
      return;
    }
    // 首次放行时若道次上还没有留档（该道从未登记过补磨），按当前记录盖一次「放行」戳；已有留档不动
    const stamp = coat.polishStamp ?? buildPolishStamp(rows, row.seq, 'finish');
    await updateCoat(coat.id, { state: 'done', needRecheck: false, polishStamp: stamp });
    message.success(`第 ${row.seq} 道按 ${effectiveGrit(row)} 目打磨完成，道次已置为已完成`);
  };

  const columns: ColumnsType<Polish> = [
    {
      title: '关联道次',
      dataIndex: 'seq',
      width: 230,
      render: (seq: number) => {
        const coat = bodyCoats.find((item) => item.seq === seq);
        if (!coat) return `第 ${seq} 道`;
        return (
          <StageTag
            state={coat.state}
            seq={seq}
            needRecheck={coat.needRecheck}
            grit={seqGritMap.get(seq)}
            polishPending={pendingSeqSet.has(seq)}
          />
        );
      },
    },
    {
      title: '原磨目数',
      dataIndex: 'grit',
      width: 100,
      render: (value: number) => <Tag>{value} 目</Tag>,
    },
    {
      title: '补磨（日期 / 目数 / 操作人）',
      key: 'touchUp',
      width: 260,
      render: (_value, record) => {
        const touch = record.touchUp;
        if (!touch) {
          return (
            <Space size={4} direction="vertical">
              <Typography.Text type="secondary">未补磨，按原记录算</Typography.Text>
              <Button size="small" type="link" icon={<RedoOutlined />} onClick={() => openTouchUp(record)} style={{ paddingInline: 0 }}>
                补记补磨
              </Button>
            </Space>
          );
        }
        const coarser = touch.grit < record.grit;
        return (
          <Space size={4} direction="vertical">
            <Space size={4} wrap>
              <Tag color={coarser ? 'error' : 'green'}>{touch.grit} 目</Tag>
              <Typography.Text>{touch.date}</Typography.Text>
              <Typography.Text type="secondary">{touch.operator || '操作人未填'}</Typography.Text>
            </Space>
            <Space size={4}>
              <Button size="small" type="link" icon={<EditOutlined />} onClick={() => openTouchUp(record)} style={{ paddingInline: 0 }}>
                改补磨
              </Button>
              <Popconfirm
                title="撤回该道补磨？"
                description="实时结论立即按原记录重算；已写进道次的留档保持不动。"
                okText="确认撤回"
                cancelText="取消"
                onConfirm={() => void withdrawTouchUp(record)}
              >
                <Button size="small" type="link" danger icon={<UndoOutlined />} style={{ paddingInline: 0 }}>
                  撤回
                </Button>
              </Popconfirm>
            </Space>
          </Space>
        );
      },
    },
    {
      title: '算数目数',
      key: 'effectiveGrit',
      width: 110,
      render: (_value, record) => {
        const grit = effectiveGrit(record);
        const pending = isReworkPending(record);
        return (
          <Tooltip title={pending ? '补磨目数比原记录粗，返工待确认' : '有补磨按补磨后目数，无补磨按原记录'}>
            <Tag color={pending ? 'error' : 'gold'} style={{ fontWeight: 600 }}>
              {grit} 目
            </Tag>
          </Tooltip>
        );
      },
    },
    {
      title: '手法',
      dataIndex: 'method',
      width: 90,
      render: (value: PolishMethod) => <Tag color={POLISH_METHOD_COLOR[value]}>{POLISH_METHOD_LABEL[value]}</Tag>,
    },
    { title: '耗时', dataIndex: 'durationMin', width: 90, render: (value: number) => `${value} 分钟` },
    {
      title: '算数操作人',
      key: 'effectiveOperator',
      width: 110,
      render: (_value, record) => effectiveOperator(record) || '未填写',
    },
    {
      title: '操作',
      key: 'action',
      width: 190,
      render: (_value, record) => (
        <Space size={4} wrap>
          <Tooltip title="打磨完成并回写道次状态（返工待确认时禁止放行）">
            <Button size="small" type="link" onClick={() => void finishPolish(record)}>
              完成打磨
            </Button>
          </Tooltip>
          <Button size="small" type="link" icon={<EditOutlined />} onClick={() => openEdit(record)}>
            编辑
          </Button>
          <Popconfirm
            title="删除该打磨记录"
            description="实时结论随之重算；道次留档不动。"
            okText="确认"
            cancelText="取消"
            onConfirm={() => void polishTable.remove(record.id).then(() => message.success('已删除'))}
          >
            <Button size="small" type="link" danger icon={<DeleteOutlined />}>
              删除
            </Button>
          </Popconfirm>
        </Space>
      ),
    },
  ];

  const touchWatchedGrit = Form.useWatch('grit', touchForm) as number | undefined;
  const touchCoarser = touchTarget !== null && typeof touchWatchedGrit === 'number' && touchWatchedGrit < touchTarget.grit;

  return (
    <div>
      <div className="gb-page-head">
        <div>
          <h2>打磨与推光工序</h2>
          <p>同一道看出花印可补记一次补磨；有没有磨到位、页顶最高目数、道次页阶段标签都按补磨后的数算。</p>
        </div>
        <Space wrap>
          <Select
            style={{ minWidth: 220 }}
            placeholder="选择胎体"
            value={bodyId || undefined}
            options={bodies.map((body) => ({
              value: body.id,
              label: `${body.code} · ${BODY_SHAPE_LABEL[body.shape]}`,
            }))}
            onChange={(value: string) => setCurrentBodyId(value)}
          />
          <Button icon={<ThunderboltOutlined />} onClick={() => void generateSequence()}>
            按道次生成序列
          </Button>
          <Button type="primary" icon={<PlusOutlined />} onClick={openCreate}>
            新增打磨记录
          </Button>
        </Space>
      </div>

      <div className="gb-stat-row">
        <StatBadge label="打磨记录" value={rows.length} suffix="条" tone="primary" />
        <StatBadge label="累计耗时" value={totalMinutes} suffix="分钟" tone="info" />
        <StatBadge label="最高目数" value={topGrit || '-'} suffix="目" tone="warning" />
        <StatBadge label="道次完成率" value={`${stat?.coatPercent ?? 0}%`} percent={stat?.coatPercent ?? 0} tone="success" />
        <StatBadge label="返工待确认" value={reworkSeqs.length} suffix="道" tone="danger" />
        <StatBadge label="阻塞道次" value={blocked.length} suffix="道" tone="danger" />
      </div>

      {reworkSeqs.length > 0 ? (
        <Alert
          type="error"
          showIcon
          style={{ marginBottom: 14 }}
          message={`第 ${reworkSeqs.join('、')} 道补磨目数比原记录粗，标为返工待确认`}
          description="回粗砂属于返工，需负责人确认后才能放行；请在补磨登记中改为更细目数，或到质检页登记返工。"
        />
      ) : null}

      {blocked.length > 0 ? (
        <Alert
          type="warning"
          showIcon
          style={{ marginBottom: 14 }}
          message={`第 ${blocked.map((coat) => coat.seq).join('、')} 道尚未打磨完成，禁止进入下一道罩漆`}
          description="请先补登打磨记录并点击「完成打磨」，把道次推进为已完成。"
        />
      ) : reworkSeqs.length === 0 ? (
        <Alert type="success" showIcon style={{ marginBottom: 14 }} message="当前胎体道次打磨均已闭环，可继续下一道罩漆" />
      ) : null}

      <Card className="gb-table-card" styles={{ body: { padding: 0 } }}>
        {rows.length === 0 ? (
          <EmptyPanel
            title={bodyCoats.length === 0 ? '该胎体尚未编排道次' : '还没有打磨记录'}
            description={
              bodyCoats.length === 0
                ? '先到「髹涂道次」页编排道次，再按道次生成打磨目数序列。'
                : '可点击「按道次生成序列」按 320→2000 目自动铺排，再逐条补录操作人。'
            }
            actionText="按道次生成序列"
            onAction={() => void generateSequence()}
            secondaryText="新增打磨记录"
            onSecondary={openCreate}
            size="small"
          />
        ) : (
          <Table<Polish> rowKey="id" size="small" pagination={{ pageSize: 8 }} columns={columns} dataSource={rows} />
        )}
      </Card>

      <Typography.Text type="secondary" style={{ display: 'block', marginTop: 10 }}>
        标准目数序列：{GRIT_SEQUENCE.join(' → ')} 目；最高目数与道次阶段标签均按补磨后的实际目数算。
        补磨登记当时会把结论盖进道次留档，事后改补磨 / 撤补磨只翻盘实时结论，留档差异到「髹涂道次」页查看。
      </Typography.Text>

      <Modal
        open={open}
        title={editing ? `编辑第 ${editing.seq} 道打磨记录` : '新增打磨记录'}
        onCancel={() => setOpen(false)}
        onOk={() => void submit()}
        okText="保存"
        cancelText="取消"
        destroyOnClose
      >
        <Form form={form} layout="vertical" preserve={false}>
          <Space size={12} style={{ display: 'flex' }}>
            <Form.Item name="seq" label="关联道次" rules={[{ required: true }]} style={{ flex: 1 }}>
              <Select
                options={(bodyCoats.length > 0
                  ? bodyCoats.map((coat) => ({ value: coat.seq, label: `第 ${coat.seq} 道 · ${coat.colorName}` }))
                  : [{ value: 1, label: '第 1 道' }]
                )}
              />
            </Form.Item>
            <Form.Item name="grit" label="原磨目数" rules={[{ required: true }]} style={{ flex: 1 }}>
              <Select options={GRIT_SEQUENCE.map((grit) => ({ value: grit, label: `${grit} 目` }))} />
            </Form.Item>
          </Space>
          <Space size={12} style={{ display: 'flex' }}>
            <Form.Item name="method" label="手法" rules={[{ required: true }]} style={{ flex: 1 }}>
              <Select options={[...POLISH_METHOD_OPTIONS]} />
            </Form.Item>
            <Form.Item name="durationMin" label="耗时（分钟）" rules={[{ required: true }]} style={{ flex: 1 }}>
              <InputNumber min={1} max={600} style={{ width: '100%' }} />
            </Form.Item>
          </Space>
          <Form.Item name="operator" label="操作人">
            <Input placeholder="如：王丽" />
          </Form.Item>
          <Typography.Text type="secondary">
            原磨之后看出花印的，保存后在列表里「补记补磨」；每条记录至多补记一次。
          </Typography.Text>
        </Form>
      </Modal>

      <Modal
        open={touchTarget !== null}
        title={touchTarget ? `第 ${touchTarget.seq} 道补磨登记（原磨 ${touchTarget.grit} 目）` : '补磨登记'}
        onCancel={() => setTouchTarget(null)}
        onOk={() => void submitTouchUp()}
        okText="保存补磨"
        cancelText="取消"
        destroyOnClose
      >
        <Form form={touchForm} layout="vertical" preserve={false}>
          <Space size={12} style={{ display: 'flex' }}>
            <Form.Item
              name="date"
              label="补磨日期"
              rules={[{ required: true, message: '请选择补磨日期' }]}
              style={{ flex: 1 }}
              getValueProps={(value: string | undefined) => ({ value: value ? dayjs(value, 'YYYY-MM-DD') : undefined })}
              getValueFromEvent={(value: dayjs.Dayjs | null) => (value ? value.format('YYYY-MM-DD') : '')}
            >
              <DatePicker style={{ width: '100%' }} allowClear={false} />
            </Form.Item>
            <Form.Item name="grit" label="补磨目数" rules={[{ required: true, message: '请选择补磨目数' }]} style={{ flex: 1 }}>
              <Select options={GRIT_SEQUENCE.map((grit) => ({ value: grit, label: `${grit} 目` }))} />
            </Form.Item>
          </Space>
          <Form.Item name="operator" label="补磨操作人" rules={[{ required: true, message: '请填写补磨操作人' }]}>
            <Input placeholder="如：王丽" />
          </Form.Item>
          {touchCoarser ? (
            <Alert
              type="error"
              showIcon
              message={`补磨 ${touchWatchedGrit} 目比原记录 ${touchTarget?.grit} 目粗，保存后该道标为「返工待确认」`}
              description="回粗砂属于返工，髹涂台将无法放行，需负责人确认后重新细磨。"
            />
          ) : (
            <Alert type="info" showIcon message="保存后这道改按补磨后的目数算数，并同时把结论盖进道次留档。" />
          )}
        </Form>
      </Modal>
    </div>
  );
}
