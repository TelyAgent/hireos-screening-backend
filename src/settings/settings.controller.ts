import { Body, Controller, Delete, Get, Param, Post, Put, Req, UseGuards } from '@nestjs/common';
import { WorkspaceGuard, type Identity } from '../auth/workspace.guard';
import { SettingsService } from './settings.service';

@Controller()
@UseGuards(WorkspaceGuard)
export class SettingsController {
  constructor(private readonly settings: SettingsService) {}

  @Get('connections')
  listConnections(@Req() req: { identity: Identity }) {
    return this.settings.listConnections(req.identity);
  }

  @Post('connections/:id/read')
  readConnection(@Req() req: { identity: Identity }, @Param('id') id: string) {
    return this.settings.readConnection(req.identity, id);
  }

  @Post('connections/:id/reconnect')
  reconnectConnection(@Req() req: { identity: Identity }, @Param('id') id: string) {
    return this.settings.reconnectConnection(req.identity, id);
  }

  @Post('connections/:id/pause')
  pauseConnection(@Req() req: { identity: Identity }, @Param('id') id: string) {
    return this.settings.pauseConnection(req.identity, id);
  }

  @Get('activity')
  listActivity(@Req() req: { identity: Identity }) {
    return this.settings.listActivity(req.identity);
  }

  @Get('audit')
  listAudit(@Req() req: { identity: Identity }) {
    return this.settings.listActivity(req.identity);
  }

  @Get('preferences')
  getPreferences(@Req() req: { identity: Identity }) {
    return this.settings.getPreferences(req.identity);
  }

  @Post('preferences/proposals/:id/activate')
  activateProposal(@Req() req: { identity: Identity }, @Param('id') id: string) {
    return this.settings.activateProposal(req.identity, id);
  }

  @Post('preferences/proposals/:id/reject')
  rejectProposal(@Req() req: { identity: Identity }, @Param('id') id: string) {
    return this.settings.rejectProposal(req.identity, id);
  }

  @Post('preferences/versions/:id/rollback')
  rollbackPreference(@Req() req: { identity: Identity }, @Param('id') id: string) {
    return this.settings.rollbackPreference(req.identity, id);
  }

  @Get('ai-models')
  getAiModels(@Req() req: { identity: Identity }) {
    return this.settings.getAiModels(req.identity);
  }

  @Get('ai-models/activity')
  getAiModelActivity(@Req() req: { identity: Identity }) {
    return this.settings.getAiModelActivity(req.identity);
  }

  @Get('settings/corporate-mailboxes')
  listCorporateMailboxes(@Req() req: { identity: Identity }) {
    return this.settings.listCorporateMailboxes(req.identity);
  }

  @Get('settings/corporate-mailboxes/:id')
  getCorporateMailbox(@Req() req: { identity: Identity }, @Param('id') id: string) {
    return this.settings.getCorporateMailbox(req.identity, id);
  }

  @Post('settings/corporate-mailboxes')
  createCorporateMailbox(@Req() req: { identity: Identity }, @Body() body: unknown) {
    return this.settings.createCorporateMailbox(req.identity, body);
  }

  @Put('settings/corporate-mailboxes/:id')
  updateCorporateMailbox(@Req() req: { identity: Identity }, @Param('id') id: string, @Body() body: unknown) {
    return this.settings.updateCorporateMailbox(req.identity, id, body);
  }

  @Delete('settings/corporate-mailboxes/:id')
  deleteCorporateMailbox(@Req() req: { identity: Identity }, @Param('id') id: string) {
    return this.settings.deleteCorporateMailbox(req.identity, id);
  }

  @Post('settings/corporate-mailboxes/:id/enabled')
  setCorporateMailboxEnabled(@Req() req: { identity: Identity }, @Param('id') id: string, @Body() body: { enabled: boolean }) {
    return this.settings.setCorporateMailboxEnabled(req.identity, id, Boolean(body?.enabled));
  }

  // No :id here -- this also has to work for a brand-new account that hasn't
  // been created yet, which is exactly when "test before you save" matters most.
  @Post('settings/corporate-mailboxes/test')
  testCorporateMailbox(@Req() req: { identity: Identity }, @Body() body: unknown) {
    return this.settings.testCorporateMailbox(req.identity, body);
  }

  @Post('settings/corporate-mailboxes/:id/sync')
  syncCorporateMailbox(@Req() req: { identity: Identity }, @Param('id') id: string) {
    return this.settings.syncCorporateMailbox(req.identity, id);
  }

  @Post('settings/corporate-mailboxes/:id/import')
  importFromMailbox(@Req() req: { identity: Identity }, @Param('id') id: string) {
    return this.settings.importFromMailbox(req.identity, id);
  }
}
