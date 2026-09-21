import { Body, Controller, Get, Param, Post, Query, Req, UseGuards } from '@nestjs/common';
import { WorkspaceGuard, type Identity } from '../auth/workspace.guard';
import { TasksService } from './tasks.service';

@Controller('tasks')
@UseGuards(WorkspaceGuard)
export class TasksController {
  constructor(private readonly tasks: TasksService) {}

  @Get()
  list(@Req() req: { identity: Identity }, @Query('scope') scope?: 'mine' | 'queue', @Query('applicationId') applicationId?: string) {
    return this.tasks.list(req.identity, scope, applicationId);
  }

  @Post(':id/claim')
  claim(@Req() req: { identity: Identity }, @Param('id') id: string) {
    return this.tasks.claim(req.identity, id);
  }

  @Post(':id/defer')
  defer(@Req() req: { identity: Identity }, @Param('id') id: string, @Body() body: { reason?: string; resumeInDays?: number }) {
    return this.tasks.defer(req.identity, id, body?.reason || '', body?.resumeInDays);
  }

  @Post(':id/complete')
  complete(@Req() req: { identity: Identity }, @Param('id') id: string, @Body() body: { completionRef?: string }) {
    return this.tasks.complete(req.identity, id, body?.completionRef);
  }
}
