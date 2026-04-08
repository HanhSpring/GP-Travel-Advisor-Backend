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

  const corsOrigin = process.env.CORS_ORIGIN || 'http://localhost:5173';
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

      // Always allow localhost/127.0.0.1 with any port for dev web builds.
      const isLocalDevOrigin =
        /^https?:\/\/localhost:\d+$/i.test(origin) ||
        /^https?:\/\/127\.0\.0\.1:\d+$/i.test(origin);

      if (isLocalDevOrigin || allowedOrigins.includes(origin)) {
        callback(null, true);
        return;
      }

      callback(new Error(`CORS blocked for origin: ${origin}`), false);
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

  const host = process.env.API_SERVICE_HOST || '0.0.0.0';
  const preferredPort = Number(process.env.API_SERVICE_PORT || 3000);
  const maxPortAttempts = Number(process.env.API_SERVICE_PORT_RETRIES || 20); // Added max port attempts

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
      if ((error as NodeJS.ErrnoException).code !== 'EADDRINUSE') {
        throw error;
      }
    }
  }

  throw new Error(
    `Could not find a free port in range ${preferredPort}-${preferredPort + maxPortAttempts}`,
  );
}
void bootstrap();
