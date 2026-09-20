const { test } = require('node:test');
const assert = require('node:assert/strict');
const { ConfigService } = require('@nestjs/config');
const { HealthService } = require('../dist/health/health.service');
const { WorkspaceGuard } = require('../dist/auth/workspace.guard');
const { splitText, normalizeTextForDedupe } = require('../dist/intake/materials.service');
const { normalizeName, displayNameFromFileName, errorDetails } = require('../dist/intake/imports.service');
const { ProfileParserService } = require('../dist/profiles/profile-parser.service');
const { parseJobDefinition } = require('../dist/jobs/job-definition.parser');
const { SecurityScanService } = require('../dist/intake/security-scan.service');

test('phase 0 health payload is stable', () => {
  const payload = new HealthService().getHealth();
  assert.equal(payload.status, 'ok');
  assert.equal(payload.service, 'hireos-resume-screening-backend');
  assert.equal(payload.phase, 'phase-7');
  assert.match(payload.timestamp, /^\d{4}-\d{2}-\d{2}T/);
});

test('workspace guard rejects production and missing development auth', () => {
  const context = {
    switchToHttp() {
      return { getRequest: () => ({}) };
    },
  };

  assert.throws(
    () => new WorkspaceGuard(new ConfigService({ NODE_ENV: 'production', DEV_AUTH_ENABLED: 'true' })).canActivate(context),
    (error) => error.getStatus() === 401 && error.response.code === 'AUTH_REQUIRED',
  );
  assert.throws(
    () => new WorkspaceGuard(new ConfigService({ NODE_ENV: 'development', DEV_AUTH_ENABLED: 'false' })).canActivate(context),
    (error) => error.getStatus() === 401 && error.response.code === 'AUTH_REQUIRED',
  );
});

test('workspace guard injects an explicit local development identity', () => {
  const request = {};
  const context = {
    switchToHttp() {
      return { getRequest: () => request };
    },
  };

  assert.equal(
    new WorkspaceGuard(new ConfigService({ NODE_ENV: 'development', DEV_AUTH_ENABLED: 'true' })).canActivate(context),
    true,
  );
  assert.deepEqual(request.identity, {
    workspaceId: 'local-screening-workspace',
    actorId: 'local-screening-user',
    roles: ['recruiter', 'hiring_manager', 'admin'],
  });
});

test('phase 1 text and filename normalization preserve source boundaries', () => {
  assert.deepEqual(splitText('Alex Morgan\n\nBuilt APIs.'), [
    { id: '', text: 'Alex Morgan' },
    { id: '', text: 'Built APIs.' },
  ]);
  assert.equal(normalizeName('Alex_Morgan_resume_v2.pdf'), 'alex morgan');
  assert.equal(displayNameFromFileName('alex_morgan_resume_v2.pdf'), 'Alex Morgan');
});

test('local profile parser extracts evidence-backed contact and skills', () => {
  const parser = new ProfileParserService();
  const profile = parser.parse('mat-1', [
    { id: 's1', text: 'Grace Hopper\n\n' +
      'grace.hopper@example.com\n+1 212-555-0199\n' +
      'Location: Arlington, Virginia\nSkills: TypeScript, React, AWS' },
  ], 'Fallback Name');
  assert.equal(profile.displayName, 'Grace Hopper');
  assert.equal(profile.email, 'grace.hopper@example.com');
  assert.equal(profile.location.value, 'Arlington, Virginia');
  assert.deepEqual(profile.skills.map((skill) => skill.name), ['TypeScript', 'React', 'AWS']);
  assert.equal(profile.skills[0].evidence.sourceMaterialId, 'mat-1');
});

test('job definition parser preserves source structure for reusable imports', () => {
  const definition = parseJobDefinition(
    '职位名称：高级后端工程师\n' +
    '所属部门：AI 平台研发部\n' +
    '工作地点：杭州\n' +
    '工作模式：全职\n' +
    '汇报对象：后端技术负责人\n\n' +
    '职位概述\n负责 AI 平台基础设施建设。\n\n' +
    '主要职责\n1. 负责后端服务架构设计、编码和发布。\n2. 建设监控和告警机制。\n\n' +
    '任职要求\n1. 具备 5 年及以上后端研发经验。\n2. 熟悉 PostgreSQL 和 Redis。\n\n' +
    '加分项\n1. 有 Kubernetes 经验。\n\n' +
    '我们提供\n参与平台核心基础设施建设。',
  );
  assert.equal(definition.title, '高级后端工程师');
  assert.equal(definition.location, '杭州');
  assert.equal(definition.responsibilities.length, 2);
  assert.equal(definition.requirements.length, 3);
  assert.equal(definition.requirements.filter((item) => item.priority === 'must_have').length, 2);
  assert.equal(definition.requirements.filter((item) => item.priority === 'nice_to_have').length, 1);
  assert.equal(definition.dimensions.length, 5);
  assert.equal(definition.dimensions.reduce((sum, item) => sum + item.weight, 0), 1);
});

test('errorDetails marks file-level user errors as non-retryable and other failures as retryable', () => {
  const badRequestLike = (code) => ({ response: { code, message: 'bad' } });

  assert.equal(errorDetails(badRequestLike('EMPTY_FILE')).retryable, false);
  assert.equal(errorDetails(badRequestLike('FILE_TOO_LARGE')).retryable, false);
  assert.equal(errorDetails(badRequestLike('UNSUPPORTED_FILE_TYPE')).retryable, false);

  // Unclassified failures (DB hiccup, downstream service timeout, etc.) must stay
  // retryable, otherwise a transient outage would permanently strand an import item.
  assert.equal(errorDetails(new Error('ECONNRESET')).retryable, true);
  assert.equal(errorDetails({}).retryable, true);
});

test('security scan quarantines disguised executables and active-content documents', () => {
  const scanner = new SecurityScanService();

  const exe = Buffer.concat([Buffer.from([0x4d, 0x5a]), Buffer.from('fake pe body')]);
  assert.deepEqual(scanner.scan(exe, 'text/plain', 'resume.txt'), {
    status: 'quarantined',
    reason: 'EXECUTABLE_SIGNATURE_DETECTED',
  });

  const pdfWithJs = Buffer.from('%PDF-1.4\n<< /OpenAction << /S /JavaScript /JS (app.alert(1)) >> >>');
  assert.deepEqual(scanner.scan(pdfWithJs, 'application/pdf', 'resume.pdf'), {
    status: 'quarantined',
    reason: 'PDF_ACTIVE_CONTENT_DETECTED',
  });

  const docxWithMacro = Buffer.from('PK\x03\x04...word/vbaProject.bin...');
  assert.deepEqual(
    scanner.scan(docxWithMacro, 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'resume.docx'),
    { status: 'quarantined', reason: 'OFFICE_MACRO_DETECTED' },
  );

  const cleanText = Buffer.from('Jane Doe\nSkills: TypeScript');
  assert.deepEqual(scanner.scan(cleanText, 'text/plain', 'resume.txt'), { status: 'passed' });
});

test('normalizeTextForDedupe collapses formatting so the same content hashes identically', () => {
  const fromPdf = 'Jane Doe\n\nEmail: jane@example.com\n\nSkills: TypeScript, React';
  const fromDocx = 'Jane   Doe\nEmail:  jane@example.com\nSkills:   TypeScript,   React  ';
  assert.equal(normalizeTextForDedupe(fromPdf), normalizeTextForDedupe(fromDocx));

  const different = 'John Smith\nEmail: john@example.com\nSkills: Go, Kubernetes';
  assert.notEqual(normalizeTextForDedupe(fromPdf), normalizeTextForDedupe(different));

  // CJK text must survive normalization, not get stripped to nothing.
  assert.equal(normalizeTextForDedupe('张三\n技能：TypeScript'), '张三 技能 typescript');
});
