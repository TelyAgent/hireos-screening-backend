import {
  Controller,
  Get,
  Headers,
  Param,
  Post,
  Req,
  UploadedFile,
  UploadedFiles,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor, FilesInterceptor } from '@nestjs/platform-express';
import { WorkspaceGuard, type Identity } from '../auth/workspace.guard';
import { MaterialsService } from './materials.service';
import { ImportsService } from './imports.service';

type MulterFile = Express.Multer.File;

@Controller()
@UseGuards(WorkspaceGuard)
export class IntakeController {
  constructor(
    private readonly materials: MaterialsService,
    private readonly imports: ImportsService,
  ) {}

  @Post('materials')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: 25 * 1024 * 1024, files: 1 } }))
  upload(@Req() req: { identity: Identity }, @UploadedFile() file?: MulterFile) {
    return this.materials.saveUpload(req.identity.workspaceId, file);
  }

  @Get('materials/:id')
  material(@Req() req: { identity: Identity }, @Param('id') id: string) {
    return this.materials.get(req.identity.workspaceId, id);
  }

  @Get('materials')
  listMaterials(@Req() req: { identity: Identity }) {
    return this.materials.list(req.identity.workspaceId);
  }

  @Get('files/:id')
  file(@Req() req: { identity: Identity }, @Param('id') id: string) {
    return this.materials.get(req.identity.workspaceId, id);
  }

  @Get('files')
  listFiles(@Req() req: { identity: Identity }) {
    return this.materials.list(req.identity.workspaceId);
  }

  @Post('imports')
  @UseInterceptors(FilesInterceptor('files', 20, { limits: { fileSize: 25 * 1024 * 1024, files: 20 } }))
  createImport(
    @Req() req: { identity: Identity },
    @UploadedFiles() files: MulterFile[],
    @Headers('x-import-channel') channel: 'manual_upload' | 'email' | 'folder' | 'api' | undefined,
  ) {
    return this.imports.createBatch(req.identity, files, channel || 'manual_upload');
  }

  @Get('imports/:id')
  getImport(@Req() req: { identity: Identity }, @Param('id') id: string) {
    return this.imports.getBatch(req.identity.workspaceId, id);
  }

  @Get('intake')
  unifiedIntake(@Req() req: { identity: Identity }) {
    return this.imports.unifiedIntake(req.identity.workspaceId);
  }
}
