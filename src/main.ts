import { Logger, ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  const config = app.get(ConfigService);
  const corsOrigin = config.get<string>('CORS_ORIGIN');

  app.setGlobalPrefix('api');
  app.enableCors({
    origin: corsOrigin
      ? corsOrigin.split(',').map((origin) => origin.trim()).filter(Boolean)
      : true,
    credentials: true,
  });
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      transform: true,
      forbidNonWhitelisted: true,
    }),
  );
  app.enableShutdownHooks();

  const port = config.get<number>('PORT', 3002);
  const host = config.get<string>('HOST', '127.0.0.1');
  await app.listen(port, host);
  Logger.log(`Resume Screening backend listening on http://${host}:${port}/api`, 'Bootstrap');
}

void bootstrap();
