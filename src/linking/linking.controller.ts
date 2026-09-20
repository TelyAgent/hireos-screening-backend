import { Body, Controller, Get, Param, Post, Query, Req, UseGuards } from '@nestjs/common';
import { WorkspaceGuard, type Identity } from '../auth/workspace.guard';
import { LinkingService } from './linking.service';

@Controller()
@UseGuards(WorkspaceGuard)
export class LinkingController {
  constructor(private readonly linking: LinkingService) {}

  @Post('recommendations/:id/confirm-link')
  confirm(@Req() req: { identity: Identity }, @Param('id') id: string, @Body() body: { reason?: string }) {
    return this.linking.confirmRecommendation(req.identity, id, body?.reason);
  }

  @Get('applications')
  list(@Req() req: { identity: Identity }, @Query('jobId') jobId?: string) {
    return this.linking.listApplications(req.identity, jobId);
  }

  @Get('applications/:id')
  get(@Req() req: { identity: Identity }, @Param('id') id: string) {
    return this.linking.getApplication(req.identity, id);
  }
}
