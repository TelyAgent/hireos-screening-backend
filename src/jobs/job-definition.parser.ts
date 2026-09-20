import { createHash } from 'node:crypto';

export type ParsedJobRequirement = {
  id: string;
  label: string;
  dimension: string;
  priority: 'must_have' | 'nice_to_have';
  hard: boolean;
  kind: 'authorization' | 'experience' | 'skill' | 'other';
  evidenceStandard: string;
};

export type ParsedJobDimension = {
  id: string;
  name: string;
  weight: number;
  rubric: string;
};

export type ParsedJobDefinition = {
  title: string;
  team: string;
  location: string;
  employmentType: string;
  seniority: string;
  roleSummary: string;
  responsibilities: string[];
  requirements: ParsedJobRequirement[];
  dimensions: ParsedJobDimension[];
  hiringContext: {
    department: string;
    location: string;
    workMode: string;
    reportingTo: string;
  };
  successCriteria: Array<{ statement: string; source: 'inferred'; status: 'needs_confirmation' }>;
};

const SECTION_NAMES = new Set(['职位概述', '主要职责', '任职要求', '加分项', '我们提供']);

export function parseJobDefinition(sourceText: string): ParsedJobDefinition {
  const lines = sourceText
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const headers = Object.fromEntries(
    lines
      .filter((line) => line.includes('：'))
      .map((line) => {
        const [key, ...rest] = line.split('：');
        return [key.trim(), rest.join('：').trim()];
      }),
  );
  const sections = collectSections(lines);
  const title = headers['职位名称'];
  if (!title || !sections['任职要求']?.length) {
    throw new Error('JOB_DEFINITION_NOT_RECOGNIZED');
  }

  const dimensions = buildDimensions(title, headers['所属部门'] || '');
  const requirements = [
    ...toRequirements(sections['任职要求'], 'must_have', true, dimensions),
    ...toRequirements(sections['加分项'] || [], 'nice_to_have', false, dimensions),
  ];
  const summary = sections['职位概述']?.join(' ') || '';

  return {
    title,
    team: headers['所属部门'] || 'Unassigned',
    location: headers['工作地点'] || 'Unknown',
    employmentType: parseEmploymentType(headers['工作模式'] || ''),
    seniority: parseSeniority(title),
    roleSummary: summary,
    responsibilities: sections['主要职责'] || [],
    requirements,
    dimensions,
    hiringContext: {
      department: headers['所属部门'] || 'Unknown',
      location: headers['工作地点'] || 'Unknown',
      workMode: headers['工作模式'] || 'Unknown',
      reportingTo: headers['汇报对象'] || 'Unknown',
    },
    successCriteria: [],
  };
}

function collectSections(lines: string[]) {
  const result: Record<string, string[]> = {};
  let current: string | undefined;
  for (const line of lines) {
    if (SECTION_NAMES.has(line)) {
      current = line;
      result[current] ||= [];
      continue;
    }
    if (current && /^\d+[.、]/.test(line)) {
      result[current].push(line.replace(/^\d+[.、]\s*/, '').trim());
    }
  }
  return result;
}

function toRequirements(
  items: string[],
  priority: ParsedJobRequirement['priority'],
  hard: boolean,
  dimensions: ParsedJobDimension[],
): ParsedJobRequirement[] {
  return items.map((label) => {
    const dimension = pickDimension(label, dimensions);
    return {
      id: `req-${shortHash(label)}`,
      label,
      dimension,
      priority,
      hard,
      kind: classifyRequirement(label),
      evidenceStandard: `需要在候选人材料或后续人工核验中找到与“${label}”相对应的证据。`,
    };
  });
}

function buildDimensions(title: string, team: string): ParsedJobDimension[] {
  const text = `${title} ${team}`;
  if (/产品经理|产品/.test(text)) {
    return weightedDimensions([
      ['Product Strategy & Discovery', '产品策略、业务理解和需求定义能力。', 0.3],
      ['AI / Domain Product Depth', '对目标业务领域和 AI 产品能力的理解深度。', 0.25],
      ['0→1 Delivery & Outcomes', '从问题定义到上线、复盘和业务结果的交付能力。', 0.2],
      ['Communication & Collaboration', '跨产品、算法、工程、设计和客户团队的协作证据。', 0.15],
      ['Compensation & Location Fit', '工作地点、工作模式和岗位约束的匹配度。', 0.1],
    ]);
  }
  if (/项目经理|项目/.test(text)) {
    return weightedDimensions([
      ['Program Delivery & Governance', '项目范围、里程碑、验收和质量治理能力。', 0.3],
      ['AI / Industry Delivery Context', 'AI、行业场景和生产交付的相关经验。', 0.25],
      ['Risk & Stakeholder Management', '风险、变更、问题闭环和多方协调能力。', 0.2],
      ['Communication & Collaboration', '客户、技术和业务团队的沟通与推动证据。', 0.15],
      ['Compensation & Location Fit', '工作地点、工作模式和岗位约束的匹配度。', 0.1],
    ]);
  }
  if (/设计师|设计/.test(text)) {
    return weightedDimensions([
      ['Product & Interaction Craft', '复杂 B 端和 AI 产品的体验、交互与视觉设计能力。', 0.3],
      ['AI Experience & Systems Thinking', '将模型能力转化为可信、可控体验的能力。', 0.25],
      ['Research & Validation', '用户研究、可用性测试和数据验证能力。', 0.2],
      ['Communication & Collaboration', '与产品、算法、前端和客户团队协作落地的能力。', 0.15],
      ['Compensation & Location Fit', '工作地点、工作模式和岗位约束的匹配度。', 0.1],
    ]);
  }
  if (/财务|FP&A|运营经理/.test(text)) {
    return weightedDimensions([
      ['FP&A & Financial Modeling', '预算、预测、经营报表和财务模型能力。', 0.3],
      ['SaaS / AI Business Understanding', '订阅业务、云资源和模型成本的理解。', 0.25],
      ['Controls & Operations', '流程治理、成本归集、对账和风险控制能力。', 0.2],
      ['Communication & Collaboration', '跨销售、产品、交付和技术团队的协作能力。', 0.15],
      ['Compensation & Location Fit', '工作地点、工作模式和岗位约束的匹配度。', 0.1],
    ]);
  }
  if (/全栈/.test(text)) {
    return weightedDimensions([
      ['Full-stack Engineering', '前端、后端和业务功能的端到端工程能力。', 0.3],
      ['Product Delivery & Architecture', '业务建模、接口设计和稳定交付能力。', 0.25],
      ['Quality & Reliability', '测试、性能、安全和线上问题处理能力。', 0.2],
      ['Communication & Collaboration', '与产品、设计、测试和运营团队的协作能力。', 0.15],
      ['Compensation & Location Fit', '工作地点、工作模式和岗位约束的匹配度。', 0.1],
    ]);
  }
  return weightedDimensions([
    ['Technical Depth & Systems Design', '技术贡献、架构判断和系统权衡能力。', 0.3],
    ['Relevant Experience', '过往经历与当前岗位范围的相关程度。', 0.25],
    ['Ownership & 0→1 Delivery', '从模糊问题推进到上线结果的能力。', 0.2],
    ['Communication & Collaboration', '跨团队沟通、评审和协作落地的能力。', 0.15],
    ['Compensation & Location Fit', '工作地点、工作模式和岗位约束的匹配度。', 0.1],
  ]);
}

function weightedDimensions(items: Array<[string, string, number]>): ParsedJobDimension[] {
  return items.map(([name, rubric, weight]) => ({
    id: `dim-${slug(name)}`,
    name,
    weight,
    rubric,
  }));
}

function pickDimension(label: string, dimensions: ParsedJobDimension[]) {
  const text = label.toLowerCase();
  const matchers: Array<[RegExp, string]> = [
    [/沟通|协作|推动|表达|会议|跨部门|团队/, 'Communication & Collaboration'],
    [/地点|远程|工作模式|授权|签证|合法工作/, 'Compensation & Location Fit'],
    [/产品|需求|客户|用户|原型|figma|交互/, 'Product Strategy & Discovery'],
    [/项目|交付|里程碑|验收|风险|变更/, 'Program Delivery & Governance'],
    [/财务|预算|预测|报表|成本|现金流|审计|税务/, 'FP&A & Financial Modeling'],
    [/设计|视觉|研究|可用性|信息架构/, 'Product & Interaction Craft'],
    [/前端|后端|python|go|java|typescript|react|数据库|redis|kafka|kubernetes|分布式|系统|架构|代码|测试|api/, 'Technical Depth & Systems Design'],
    [/模型|rag|知识库|大语言模型|ai|算法|embedding/, 'AI / Domain Product Depth'],
    [/交付|上线|发布|故障|维护|owner|项目/, 'Ownership & 0→1 Delivery'],
  ];
  for (const [pattern, name] of matchers) {
    const dimension = dimensions.find((item) => item.name === name);
    if (dimension && pattern.test(text)) return dimension.id;
  }
  return dimensions[1]?.id || dimensions[0].id;
}

function classifyRequirement(label: string): ParsedJobRequirement['kind'] {
  if (/授权|签证|工作许可|合法工作/.test(label)) return 'authorization';
  if (/熟悉|掌握|使用|能力|经验|项目|交付|管理|设计|沟通|分析/.test(label)) return 'experience';
  if (/python|go|java|typescript|react|sql|redis|kafka|kubernetes|figma|excel|power bi|tableau/i.test(label)) return 'skill';
  return 'other';
}

function parseEmploymentType(workMode: string) {
  return /全职/.test(workMode) ? 'Full-time' : workMode || 'Unknown';
}

function parseSeniority(title: string) {
  if (/高级|资深|负责人|总监/.test(title)) return 'Senior';
  if (/经理/.test(title)) return 'Manager';
  return 'Experienced';
}

function slug(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

function shortHash(value: string) {
  return createHash('sha256').update(value).digest('hex').slice(0, 12);
}
