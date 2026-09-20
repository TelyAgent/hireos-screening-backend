import { Controller, Get, Param, Post, Body, Query, Req, UseGuards } from '@nestjs/common';
import { WorkspaceGuard, type Identity } from '../auth/workspace.guard';
import { CandidatesService } from './candidates.service';
import { LibraryService } from './library.service';

@Controller()
@UseGuards(WorkspaceGuard)
export class LibraryController {
  constructor(
    private readonly candidates: CandidatesService,
    private readonly library: LibraryService,
  ) {}

  @Get('library')
  list(@Req() req: { identity: Identity }, @Query('q') query?: string) {
    return this.library.list(req.identity, query);
  }

  @Post('candidates')
  create(@Req() req: { identity: Identity }, @Body() body: unknown) {
    return this.candidates.createManual(req.identity, body);
  }

  @Get('candidates/:id')
  get(@Req() req: { identity: Identity }, @Param('id') id: string) {
    return this.candidates.get(req.identity, id);
  }
}
