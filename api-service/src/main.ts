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
  app.enableCors({
    origin: corsOrigin.split(',').map((origin) => origin.trim()),
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
