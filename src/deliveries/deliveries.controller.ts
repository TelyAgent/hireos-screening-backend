import { Body, Controller, Get, Param, Post, Req, UseGuards } from '@nestjs/common';
import { WorkspaceGuard, type Identity } from '../auth/workspace.guard';
import { DeliveriesService } from './deliveries.service';

@Controller()
@UseGuards(WorkspaceGuard)
export class DeliveriesController {
  constructor(private readonly deliveries: DeliveriesService) {}

  @Get('deliveries')
  list(@Req() req: { identity: Identity }) {
    return this.deliveries.list(req.identity);
  }

  @Get('deliveries/:id')
  get(@Req() req: { identity: Identity }, @Param('id') id: string) {
    return this.deliveries.get(req.identity, id);
  }

  @Post('deliveries/:id/send')
  send(@Req() req: { identity: Identity }, @Param('id') id: string) {
    return this.deliveries.send(req.identity, id);
  }

  @Post('deliveries/:id/retry')
  retry(@Req() req: { identity: Identity }, @Param('id') id: string) {
    return this.deliveries.retry(req.identity, id);
  }

  @Post('deliveries/:id/receipt')
  receipt(
    @Req() req: { identity: Identity },
    @Param('id') id: string,
    @Body() body: { externalRef?: string; imported?: boolean },
  ) {
    return this.deliveries.recordReceipt(req.identity, id, body);
  }

  @Post('deliveries/:id/download')
  download(@Req() req: { identity: Identity }, @Param('id') id: string) {
    return this.deliveries.download(req.identity, id);
  }
}
