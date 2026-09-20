import { Body, Controller, Get, Param, Post, Req, UseGuards } from '@nestjs/common';
import { WorkspaceGuard, type Identity } from '../auth/workspace.guard';
import { ComparisonsService } from './comparisons.service';

@Controller('comparisons')
@UseGuards(WorkspaceGuard)
export class ComparisonsController {
  constructor(private readonly comparisons: ComparisonsService) {}

  @Post()
  create(
    @Req() req: { identity: Identity },
    @Body() body: { jobId?: string; purpose?: string; applicationIds?: string[] },
  ) {
    return this.comparisons.create(req.identity, body);
  }

  @Get(':id')
  get(@Req() req: { identity: Identity }, @Param('id') id: string) {
    return this.comparisons.get(req.identity, id);
  }

  @Post(':id/members')
  addMember(
    @Req() req: { identity: Identity },
    @Param('id') id: string,
    @Body() body: { applicationId?: string },
  ) {
    return this.comparisons.addMember(req.identity, id, body?.applicationId);
  }

  @Post(':id/refresh')
  refresh(@Req() req: { identity: Identity }, @Param('id') id: string) {
    return this.comparisons.refresh(req.identity, id);
  }

  @Post(':id/annotations')
  annotate(
    @Req() req: { identity: Identity },
    @Param('id') id: string,
    @Body() body: { targetId?: string; body?: string },
  ) {
    return this.comparisons.annotate(req.identity, id, body);
  }

  @Post(':id/exports')
  export(
    @Req() req: { identity: Identity },
    @Param('id') id: string,
    @Body() body: { format?: 'png' | 'pdf'; applicationIds?: string[] },
  ) {
    return this.comparisons.export(req.identity, id, body);
  }
}
