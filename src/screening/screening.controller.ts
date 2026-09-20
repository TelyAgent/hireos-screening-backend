import { Body, Controller, Get, Param, Patch, Post, Req, UseGuards } from '@nestjs/common';
import { WorkspaceGuard, type Identity } from '../auth/workspace.guard';
import { ScreeningService } from './screening.service';

@Controller()
@UseGuards(WorkspaceGuard)
export class ScreeningController {
  constructor(private readonly screening: ScreeningService) {}

  @Get('applications/:id/screening')
  detail(@Req() req: { identity: Identity }, @Param('id') id: string) {
    return this.screening.getDetail(req.identity, id);
  }

  @Get('applications/:id/evaluations')
  history(@Req() req: { identity: Identity }, @Param('id') id: string) {
    return this.screening.listEvaluations(req.identity, id);
  }

  @Post('applications/:id/screen')
  run(@Req() req: { identity: Identity }, @Param('id') id: string) {
    return this.screening.run(req.identity, id, 'initial');
  }

  @Post('evaluations/:id/refresh')
  refresh(@Req() req: { identity: Identity }, @Param('id') id: string) {
    return this.screening.refresh(req.identity, id);
  }

  @Patch('evaluations/:id/human-assessments')
  humanAssessment(
    @Req() req: { identity: Identity },
    @Param('id') id: string,
    @Body() body: { dimensionId?: string; dimensionName?: string; score?: number; reason?: string },
  ) {
    return this.screening.saveHumanAssessment(req.identity, id, body);
  }

  @Post('concerns/:id/resolve')
  resolveConcern(
    @Req() req: { identity: Identity },
    @Param('id') id: string,
    @Body() body: { resolution?: string },
  ) {
    return this.screening.resolveConcern(req.identity, id, body?.resolution);
  }

  @Post('verification-items/:id/assign')
  assignVerification(@Req() req: { identity: Identity }, @Param('id') id: string) {
    return this.screening.assignVerification(req.identity, id);
  }

  @Post('verification-items/:id/resolve')
  resolveVerification(
    @Req() req: { identity: Identity },
    @Param('id') id: string,
    @Body() body: { outcome?: string },
  ) {
    return this.screening.resolveVerification(req.identity, id, body?.outcome);
  }
}
