import { BadRequestException, Body, Controller, Get, Param, Post, Req, UseGuards } from '@nestjs/common';
import { WorkspaceGuard, type Identity } from '../auth/workspace.guard';
import { DuplicatesService } from './duplicates.service';
import type { DuplicateResolutionOutcome } from './duplicates.types';

@Controller()
@UseGuards(WorkspaceGuard)
export class DuplicatesController {
  constructor(private readonly duplicates: DuplicatesService) {}

  @Get('duplicates/:id')
  get(@Req() req: { identity: Identity }, @Param('id') id: string) {
    return this.duplicates.get(req.identity, id);
  }

  @Post('duplicates/:id/resolve')
  resolve(
    @Req() req: { identity: Identity },
    @Param('id') id: string,
    @Body() body: { outcome?: DuplicateResolutionOutcome; note?: string },
  ) {
    if (!body.outcome) throw new BadRequestException({ code: 'OUTCOME_REQUIRED' });
    return this.duplicates.resolve(req.identity, id, body.outcome, body.note);
  }
}
