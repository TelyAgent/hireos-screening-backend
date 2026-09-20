import { Injectable } from '@nestjs/common';

@Injectable()
export class HealthService {
  getHealth() {
    return {
      status: 'ok',
      service: 'hireos-resume-screening-backend',
      phase: 'phase-7',
      timestamp: new Date().toISOString(),
    };
  }
}
