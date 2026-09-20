import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

export type Identity = {
  workspaceId: string;
  actorId: string;
  roles: string[];
};

@Injectable()
export class WorkspaceGuard implements CanActivate {
  constructor(private readonly config: ConfigService) {}

  canActivate(context: ExecutionContext) {
    if (this.config.get('NODE_ENV') === 'production' || this.config.get('DEV_AUTH_ENABLED') !== 'true') {
      throw new UnauthorizedException({ code: 'AUTH_REQUIRED' });
    }

    const request = context.switchToHttp().getRequest<{ identity: Identity }>();
    request.identity = {
      workspaceId: this.config.get<string>('DEV_WORKSPACE_ID', 'local-screening-workspace'),
      actorId: this.config.get<string>('DEV_ACTOR_ID', 'local-screening-user'),
      roles: ['recruiter', 'hiring_manager', 'admin'],
    };
    return true;
  }
}
