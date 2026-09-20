import { Injectable } from '@nestjs/common';
import { PrismaService } from '../persistence/prisma.service';
import { CandidatesService } from './candidates.service';
import type { Identity } from '../auth/workspace.guard';

@Injectable()
export class LibraryService {
  constructor(
    private readonly db: PrismaService,
    private readonly candidates: CandidatesService,
  ) {}

  async list(identity: Identity, query?: string) {
    const q = query?.trim();
    const candidates = await this.db.candidate.findMany({
      where: {
        workspaceId: identity.workspaceId,
        ...(q ? { displayName: { contains: q, mode: 'insensitive' } } : {}),
      },
      orderBy: { createdAt: 'desc' },
      take: 200,
      include: {
        libraryEntry: true,
        profiles: { orderBy: { version: 'desc' }, take: 1 },
        resumeVersions: {
          orderBy: { uploadedAt: 'desc' },
          take: 1,
          include: { material: { select: { name: true } } },
        },
      },
    });
    const candidateIds = candidates.map((candidate) => candidate.id);
    const recommendations = await this.db.candidateJobRecommendation.findMany({
      where: { workspaceId: identity.workspaceId, candidateId: { in: candidateIds } },
      select: { candidateId: true, status: true },
    });
    return candidates.map((candidate) => {
      const candidateRecommendations = recommendations.filter((item) => item.candidateId === candidate.id);
      const linked = candidateRecommendations.filter((item) => item.status === 'confirmed').length;
      const pending = candidateRecommendations.filter((item) => item.status === 'proposed').length;
      return {
      candidate: this.candidates.toFrontendCandidate(candidate, candidate.profiles[0]),
      latestSource: candidate.resumeVersions[0]?.source || 'Structured entry',
      matchStatus: linked ? 'linked' : pending ? 'pending' : 'not_matched',
      linkedRoleCount: linked,
      pendingRecommendationCount: pending,
      };
    });
  }
}
