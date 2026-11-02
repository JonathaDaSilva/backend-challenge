import { type CanActivate, createParamDecorator, type ExecutionContext, Inject, Injectable, SetMetadata } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { UnauthenticatedError } from '../../application/errors';
import { AUTHENTICATOR, type Authenticator, type Principal, type RequestHeaders } from './authenticator';

const IS_PUBLIC = 'auth:public';

export const Public = () => SetMetadata(IS_PUBLIC, true);

interface AuthenticatedRequest {
  headers: RequestHeaders;
  principal?: Principal;
}

export const CurrentPrincipal = createParamDecorator(
  (_: unknown, context: ExecutionContext): Principal | undefined =>
    context.switchToHttp().getRequest<AuthenticatedRequest>().principal,
);

@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    @Inject(Reflector) private readonly reflector: Reflector,
    @Inject(AUTHENTICATOR) private readonly authenticator: Authenticator,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, [context.getHandler(), context.getClass()]);
    if (isPublic) return true;

    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const principal = await this.authenticator.authenticate(request.headers);
    if (!principal) throw new UnauthenticatedError('Missing or invalid credentials');
    request.principal = principal;
    return true;
  }
}
