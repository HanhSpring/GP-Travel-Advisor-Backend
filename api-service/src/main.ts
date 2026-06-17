import { AppConfig } from './config/app.config';
import 'dotenv/config';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { SwaggerModule, DocumentBuilder } from '@nestjs/swagger';
import { ValidationPipe } from '@nestjs/common';
import { Logger } from '@nestjs/common';

async function bootstrap() {
  const logger = new Logger('Bootstrap');
  const app = await NestFactory.create(AppModule, {
    logger: ['error', 'warn'],
  });

  const corsOrigin = AppConfig.CORS_ORIGIN;
  const allowedOrigins = corsOrigin
    .split(',')
    .map((origin) => origin.trim())
    .filter((origin) => origin.length > 0);
  const allowAnyOrigin = allowedOrigins.includes('*');

  app.enableCors({
    origin: (origin, callback) => {
      // Non-browser and same-origin requests may not send Origin header.
      if (!origin) {
        callback(null, true);
        return;
      }

      // Explicit wildcard in env means allow all origins.
      if (allowAnyOrigin) {
        callback(null, true);
        return;
      }

      const isLocalDevOrigin =
        /^https?:\/\/localhost:\d+$/i.test(origin) ||
        /^https?:\/\/127\.0\.0\.1:\d+$/i.test(origin) ||
        /^https?:\/\/192\.168\.\d{1,3}\.\d{1,3}:\d+$/i.test(origin) ||
        /^https?:\/\/10\.\d{1,3}\.\d{1,3}\.\d{1,3}:\d+$/i.test(origin) ||
        /^https?:\/\/172\.(1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}:\d+$/i.test(
          origin,
        );

      if (isLocalDevOrigin || allowedOrigins.includes(origin)) {
        callback(null, true);
        return;
      }

      callback(null, false);
    },
    methods: 'GET,HEAD,PUT,PATCH,POST,DELETE,OPTIONS',
    credentials: true,
  });

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      transform: true,
      forbidNonWhitelisted: true,
    }),
  );

  const config = new DocumentBuilder()
    .setTitle('Travel Advisor API')
    .setDescription('API Documentation')
    .setVersion('1.0')
    .addBearerAuth(
      {
        type: 'http',
        scheme: 'bearer',
        bearerFormat: 'JWT',
        name: 'JWT',
        description: 'Nhập mã Token của bạn vào đây',
        in: 'header',
      },
      'access-token',
    )
    .build();

  const document = SwaggerModule.createDocument(app, config);

  SwaggerModule.setup('api-docs', app, document);

  const host = AppConfig.API_SERVICE_HOST;
  const preferredPort = AppConfig.API_SERVICE_PORT;
  const maxPortAttempts = AppConfig.API_SERVICE_PORT_RETRIES; // Added max port attempts

  for (let attempt = 0; attempt <= maxPortAttempts; attempt += 1) {
    const port = preferredPort + attempt;

    try {
      await app.listen(port, host);

      if (attempt === 0) {
        logger.log(`API is running on http://localhost:${port}`);
      } else {
        logger.warn(
          `Port ${preferredPort} is in use. API started on http://localhost:${port}`,
        );
      }

      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'EADDRINUSE' && code !== 'EACCES') {
        throw error;
      }
    }
  }

  throw new Error(
    `Could not find a free port in range ${preferredPort}-${preferredPort + maxPortAttempts}`,
  );
}
void bootstrap();
