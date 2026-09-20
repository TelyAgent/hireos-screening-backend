import { Body, Controller, Get, Param, Patch, Post, Req, UseGuards } from '@nestjs/common';
import { WorkspaceGuard, type Identity } from '../auth/workspace.guard';
import { ProfilesService } from './profiles.service';

@Controller()
@UseGuards(WorkspaceGuard)
export class ProfilesController {
  constructor(private readonly profiles: ProfilesService) {}

  @Get('candidates/:id/profile')
  getLatest(@Req() req: { identity: Identity }, @Param('id') id: string) {
    return this.profiles.getLatest(req.identity, id);
  }

  @Patch('candidates/:id/profile')
  correct(@Req() req: { identity: Identity }, @Param('id') id: string, @Body() body: unknown) {
    return this.profiles.correct(req.identity, id, body);
  }

  @Get('processing-jobs/:id')
  getJob(@Req() req: { identity: Identity }, @Param('id') id: string) {
    return this.profiles.getJob(req.identity, id);
  }

  @Post('processing-jobs/:id/retry')
  retry(@Req() req: { identity: Identity }, @Param('id') id: string) {
    return this.profiles.retry(req.identity, id);
  }
}
