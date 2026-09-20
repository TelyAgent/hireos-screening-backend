const { test } = require('node:test');
const assert = require('node:assert/strict');
const { ConfigService } = require('@nestjs/config');
const { HealthService } = require('../dist/health/health.service');
const { WorkspaceGuard } = require('../dist/auth/workspace.guard');
const { splitText } = require('../dist/intake/materials.service');
const { normalizeName, displayNameFromFileName } = require('../dist/intake/imports.service');
const { ProfileParserService } = require('../dist/profiles/profile-parser.service');

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
