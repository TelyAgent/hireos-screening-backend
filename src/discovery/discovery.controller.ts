import { Controller, Get, Param, Post, Req, UseGuards } from '@nestjs/common';
import { WorkspaceGuard, type Identity } from '../auth/workspace.guard';
import { DiscoveryService } from './discovery.service';

@Controller()
@UseGuards(WorkspaceGuard)
export class DiscoveryController {
  constructor(private readonly discovery: DiscoveryService) {}

  @Post('candidates/:id/match')
  matchCandidate(@Req() req: { identity: Identity }, @Param('id') id: string) {
    return this.discovery.matchCandidate(req.identity, id);
  }

  @Post('jobs/:id/match')
  matchJob(@Req() req: { identity: Identity }, @Param('id') id: string) {
    return this.discovery.matchJob(req.identity, id);
  }

  @Get('jobs/:id/recommendations')
  listJobRecommendations(@Req() req: { identity: Identity }, @Param('id') id: string) {
    return this.discovery.listJobRecommendations(req.identity, id);
  }

  @Post('candidates/:candidateId/jobs/:jobId/recommend')
  manualRecommendation(
    @Req() req: { identity: Identity },
    @Param('candidateId') candidateId: string,
    @Param('jobId') jobId: string,
  ) {
    return this.discovery.createManual(req.identity, candidateId, jobId);
  }

  @Post('recommendations/:id/dismiss')
  dismiss(@Req() req: { identity: Identity }, @Param('id') id: string) {
    return this.discovery.dismiss(req.identity, id);
  }

  @Post('recommendations/:id/defer')
  defer(@Req() req: { identity: Identity }, @Param('id') id: string) {
    return this.discovery.defer(req.identity, id);
  }
}
