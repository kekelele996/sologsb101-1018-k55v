/**
 * /polish 打磨与推光工序录入
 * 按道次生成目数序列，未打磨完的道次禁止进入下一道罩漆。
 * 每条记录可补记一次补磨：磨到位判定、最高目数与道次结论一律按补磨后的数；
 * 补磨目数比原记录粗的标「返工待确认」，确认前不放行。
 * 消费 Polish、Coat；复用 <StageTag>、<StatBadge>、<EmptyPanel>。
 */
import { useMemo, useState } from 'react';
import {
  Alert,
  App as AntdApp,
  Button,
  Card,
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
import { DeleteOutlined, EditOutlined, PlusOutlined, RedoOutlined, ThunderboltOutlined } from '@ant-design/icons';
import EmptyPanel from '@/components/common/EmptyPanel';
import StatBadge from '@/components/common/StatBadge';
import StageTag from '@/components/common/StageTag';
import { useCoatProgress } from '@/hooks/useCoatProgress';
import { useIdbTable } from '@/hooks/useIdbTable';
import { useBodyStore } from '@/stores/bodyStore';
import { useCoatStore } from '@/stores/coatStore';
import {
  GRIT_SEQUENCE,
  POLISH_METHOD_COLOR,
  POLISH_METHOD_LABEL,
  POLISH_METHOD_OPTIONS,
  createEmptyPolishDraft,
  createEmptyReworkDraft,
  effectiveGrit,
  isPolishSettled,
  isReworkCoarser,
  summarizeSeqPolish,
  suggestGrit,
  type Polish,
  type PolishDraft,
  type PolishMethod,
  type PolishRework,
  type PolishReworkDraft,
} from '@/types/polish';
import { BODY_SHAPE_LABEL } from '@/types/body';

export default function PolishBoard() {
  const { message } = AntdApp.useApp();
  const [form] = Form.useForm<PolishDraft>();
  const [reworkForm] = Form.useForm<PolishReworkDraft>();
  const polishTable = useIdbTable<Polish>((database) => database.polishes, { sortByUpdatedAt: false });

  const bodies = useBodyStore((state) => state.bodies);
  const currentBodyId = useBodyStore((state) => state.currentBodyId);
  const setCurrentBodyId = useBodyStore((state) => state.setCurrentBodyId);
  const coats = useCoatStore((state) => state.coats);
  const updateCoat = useCoatStore((state) => state.updateCoat);
  const { progressOf } = useCoatProgress();

  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<Polish | null>(null);
  const [reworkOpen, setReworkOpen] = useState(false);
  const [reworkTarget, setReworkTarget] = useState<Polish | null>(null);

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

  /** 已涂但打磨未到位的道次：未打磨完禁止进入下一道罩漆（按补磨后的有效目数判定） */
  const blocked = useMemo(
    () => bodyCoats.filter((coat) => coat.state === 'toPolish' && !summarizeSeqPolish(coat.seq, rows).settled),
    [bodyCoats, rows],
  );

  const stat = bodyId ? progressOf(bodyId) : null;
  const totalMinutes = rows.reduce((sum, row) => sum + row.durationMin, 0);
  const maxGrit = rows.reduce((max, row) => Math.max(max, effectiveGrit(row)), 0);
  const confirmCount = rows.filter((row) => isReworkCoarser(row)).length;
  const reworkCount = rows.filter((row) => row.rework).length;

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
    });
    setOpen(true);
  };

  const submit = async (): Promise<void> => {
    const values = await form.validateFields();
    if (editing) {
      // 编辑主记录不触碰补磨子记录
      await polishTable.update(editing.id, values);
      message.success('已更新打磨记录');
    } else {
      await polishTable.create({ ...values, rework: null }, 'polish');
      message.success('已新增打磨记录');
    }
    setOpen(false);
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
          rework: null,
        },
        'polish',
      );
    }
    message.success(`已按 ${targets.length} 个道次生成目数序列（${GRIT_SEQUENCE.slice(0, targets.length).join(' / ')}）`);
  };

  /** 打磨完成后把道次推进到已完成；返工待确认或目数不达标的不放行 */
  const finishPolish = async (row: Polish): Promise<void> => {
    const coat = bodyCoats.find((item) => item.seq === row.seq);
    if (!coat) {
      message.warning('未找到对应道次');
      return;
    }
    if (isReworkCoarser(row)) {
      message.warning(`补磨目数 ${row.rework?.grit} 目比原记录 ${row.grit} 目粗，返工待确认，暂不能放行`);
      return;
    }
    const need = suggestGrit(row.seq);
    if (effectiveGrit(row) < need) {
      message.warning(`有效目数 ${effectiveGrit(row)} 目未达第 ${row.seq} 道建议的 ${need} 目，不能放行`);
      return;
    }
    await updateCoat(coat.id, { state: 'done', needRecheck: false });
    message.success(`第 ${row.seq} 道打磨完成，道次已置为已完成`);
  };

  /** 打开补磨对话框：已有补磨则改补磨，否则补记（每条记录限一次） */
  const openRework = (row: Polish): void => {
    setReworkTarget(row);
    reworkForm.setFieldsValue(
      row.rework
        ? { date: row.rework.date, grit: row.rework.grit, operator: row.rework.operator }
        : createEmptyReworkDraft(row.grit, row.operator),
    );
    setReworkOpen(true);
  };

  const submitRework = async (): Promise<void> => {
    if (!reworkTarget) return;
    const values = await reworkForm.validateFields();
    const rework: PolishRework = { ...values, at: reworkTarget.rework?.at ?? Date.now() };
    await polishTable.update(reworkTarget.id, { rework });
    if (reworkTarget.rework) {
      // 事后改补磨：实时口径按现有记录重算，道次上的冻结结论保持不动
      message.success('已修改补磨：实时结论已重算，道次上的冻结结论保持不动');
    } else {
      // 补磨登记当时把结论写进道次（冻结口径），之后改/撤补磨都不再回头
      const after = rows.map((row) => (row.id === reworkTarget.id ? { ...row, rework } : row));
      const summary = summarizeSeqPolish(reworkTarget.seq, after);
      const coat = bodyCoats.find((item) => item.seq === reworkTarget.seq);
      if (coat) {
        await updateCoat(coat.id, {
          polishFreeze: { grit: summary.maxGrit, settled: summary.settled, at: rework.at },
        });
      }
      message.success(`已登记补磨，第 ${reworkTarget.seq} 道按 ${rework.grit} 目重算并把结论冻结进道次`);
    }
    setReworkOpen(false);
  };

  /** 撤销补磨：实时口径回到原记录，道次上的冻结结论保留 */
  const revokeRework = async (row: Polish): Promise<void> => {
    await polishTable.update(row.id, { rework: null });
    message.success(`已撤销第 ${row.seq} 道补磨：按原记录重算，道次上的冻结结论保留`);
  };

  const columns: ColumnsType<Polish> = [
    {
      title: '关联道次',
      dataIndex: 'seq',
      width: 120,
      render: (seq: number) => {
        const coat = bodyCoats.find((item) => item.seq === seq);
        return coat ? <StageTag state={coat.state} seq={seq} needRecheck={coat.needRecheck} /> : `第 ${seq} 道`;
      },
    },
    {
      title: '磨料目数',
      dataIndex: 'grit',
      width: 190,
      render: (value: number, record) =>
        record.rework ? (
          <Space size={4} wrap>
            <Tooltip title={`${record.rework.date} 由 ${record.rework.operator || '未填写'} 补磨；结论按补磨后的 ${record.rework.grit} 目计算`}>
              <Tag>{value} 目</Tag>
              <Tag color="gold">补磨 {record.rework.grit} 目</Tag>
            </Tooltip>
            {isReworkCoarser(record) ? (
              <Tooltip title="补磨目数比原记录粗，需确认后才能放行">
                <Tag color="warning">返工待确认</Tag>
              </Tooltip>
            ) : null}
          </Space>
        ) : (
          <Tag color="gold">{value} 目</Tag>
        ),
    },
    {
      title: '手法',
      dataIndex: 'method',
      width: 100,
      render: (value: PolishMethod) => <Tag color={POLISH_METHOD_COLOR[value]}>{POLISH_METHOD_LABEL[value]}</Tag>,
    },
    { title: '耗时', dataIndex: 'durationMin', width: 100, render: (value: number) => `${value} 分钟` },
    { title: '操作人', dataIndex: 'operator', width: 110, render: (value: string) => value || '未填写' },
    {
      title: '磨到位',
      key: 'settled',
      width: 150,
      render: (_value, record) => {
        if (isReworkCoarser(record)) return <Tag color="warning">返工待确认</Tag>;
        if (isPolishSettled(record)) return <Tag color="success">磨到位</Tag>;
        return <Tag color="error">未到位 · 建议 {suggestGrit(record.seq)} 目</Tag>;
      },
    },
    {
      title: '操作',
      key: 'action',
      width: 330,
      render: (_value, record) => (
        <Space size={4} wrap>
          <Tooltip title="打磨完成并回写道次状态">
            <Button size="small" type="link" onClick={() => void finishPolish(record)}>
              完成打磨
            </Button>
          </Tooltip>
          <Tooltip title={record.rework ? '修改补磨（道次上的冻结结论不回头）' : '同一道补磨一遍，补记日期、目数与操作人'}>
            <Button size="small" type="link" icon={<RedoOutlined />} onClick={() => openRework(record)}>
              {record.rework ? '改补磨' : '补磨'}
            </Button>
          </Tooltip>
          {record.rework ? (
            <Popconfirm
              title="撤销该条补磨"
              description="撤销后按原记录重算；道次上的冻结结论保留不变。"
              okText="确认"
              cancelText="取消"
              onConfirm={() => void revokeRework(record)}
            >
              <Button size="small" type="link" danger>
                撤销补磨
              </Button>
            </Popconfirm>
          ) : null}
          <Button size="small" type="link" icon={<EditOutlined />} onClick={() => openEdit(record)}>
            编辑
          </Button>
          <Popconfirm
            title="删除该打磨记录"
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

  return (
    <div>
      <div className="gb-page-head">
        <div>
          <h2>打磨与推光工序</h2>
          <p>按道次生成目数序列并登记手法与耗时；同一道可补记一次补磨，此后磨到位判定与最高目数一律按补磨后的数。</p>
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
        <StatBadge label="最高目数" value={maxGrit || '-'} suffix="目" tone="warning" />
        <StatBadge label="道次完成率" value={`${stat?.coatPercent ?? 0}%`} percent={stat?.coatPercent ?? 0} tone="success" />
        <StatBadge label="阻塞道次" value={blocked.length} suffix="道" tone="danger" />
        <StatBadge label="返工待确认" value={confirmCount} suffix="条" tone="danger" />
      </div>

      {blocked.length > 0 ? (
        <Alert
          type="warning"
          showIcon
          style={{ marginBottom: 14 }}
          message={`第 ${blocked.map((coat) => coat.seq).join('、')} 道打磨未到位，禁止进入下一道罩漆`}
          description="按补磨后的有效目数判定：目数不达标或补磨比原记录粗（返工待确认）都不放行；补登打磨或修正补磨后点击「完成打磨」推进道次。"
        />
      ) : (
        <Alert type="success" showIcon style={{ marginBottom: 14 }} message="当前胎体道次打磨均已闭环，可继续下一道罩漆" />
      )}

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
        标准目数序列：{GRIT_SEQUENCE.join(' → ')} 目；当前胎体打磨 {rows.length} 条记录，其中 {reworkCount} 条已补磨。
        补磨登记时会把结论冻结进道次，事后改/撤补磨只影响实时重算，冻结结论不回头（见「髹涂道次」页打磨结论列）。
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
            <Form.Item name="grit" label="磨料目数" rules={[{ required: true }]} style={{ flex: 1 }}>
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
        </Form>
      </Modal>

      <Modal
        open={reworkOpen}
        title={reworkTarget?.rework ? `修改第 ${reworkTarget.seq} 道补磨` : `第 ${reworkTarget?.seq ?? ''} 道补磨登记`}
        onCancel={() => setReworkOpen(false)}
        onOk={() => void submitRework()}
        okText="保存"
        cancelText="取消"
        destroyOnClose
      >
        <Form form={reworkForm} layout="vertical" preserve={false}>
          <Space size={12} style={{ display: 'flex' }}>
            <Form.Item name="date" label="补磨日期" rules={[{ required: true, message: '请选择补磨日期' }]} style={{ flex: 1 }}>
              <Input type="date" />
            </Form.Item>
            <Form.Item name="grit" label="补磨目数" rules={[{ required: true, message: '请选择补磨目数' }]} style={{ flex: 1 }}>
              <Select options={GRIT_SEQUENCE.map((grit) => ({ value: grit, label: `${grit} 目` }))} />
            </Form.Item>
          </Space>
          <Form.Item name="operator" label="补磨操作人" rules={[{ required: true, message: '请填写补磨操作人' }]}>
            <Input placeholder="如：李成" />
          </Form.Item>
          <Alert
            type="info"
            showIcon
            message={
              reworkTarget?.rework
                ? '修改补磨后：实时结论按现有记录重算；道次上的冻结结论保持不动，两种口径的差别见「髹涂道次」页。'
                : '登记后会把当前结论冻结进道次；之后改或撤销补磨，冻结结论不再回头。补磨目数比原记录粗的会标「返工待确认」。'
            }
          />
        </Form>
      </Modal>
    </div>
  );
}
