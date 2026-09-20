import { Body, Controller, Get, Param, Patch, Post, Req, UseGuards } from '@nestjs/common';
import { WorkspaceGuard, type Identity } from '../auth/workspace.guard';
import { JobsService } from './jobs.service';

@Controller('jobs')
@UseGuards(WorkspaceGuard)
export class JobsController {
  constructor(private readonly jobs: JobsService) {}

  @Get()
  list(@Req() req: { identity: Identity }) {
    return this.jobs.list(req.identity);
  }

  @Post()
  create(@Req() req: { identity: Identity }, @Body() body: unknown) {
    return this.jobs.create(req.identity, body);
  }

  @Post('import')
  import(@Req() req: { identity: Identity }, @Body() body: unknown) {
    return this.jobs.importFromSource(req.identity, body);
  }

  @Get(':id')
  get(@Req() req: { identity: Identity }, @Param('id') id: string) {
    return this.jobs.get(req.identity, id);
  }

  @Patch(':id/criteria')
  updateCriteria(@Req() req: { identity: Identity }, @Param('id') id: string, @Body() body: unknown) {
    return this.jobs.updateCriteria(req.identity, id, body);
  }

  @Post(':id/criteria/confirm')
  confirmCriteria(@Req() req: { identity: Identity }, @Param('id') id: string) {
    return this.jobs.confirmCriteria(req.identity, id, req.identity.actorId);
  }

  @Post(':id/criteria/reopen')
  reopenCriteria(@Req() req: { identity: Identity }, @Param('id') id: string) {
    return this.jobs.reopenCriteria(req.identity, id);
  }
}
