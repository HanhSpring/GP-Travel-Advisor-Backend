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

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,      
      transform: true,      
      forbidNonWhitelisted: true 
    })
  )

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

  try {
    await app.listen(preferredPort, host);
    logger.log(`API is running on http://localhost:${preferredPort}`);
    return;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EADDRINUSE') {
      throw error;
    }
  }

  const fallbackPort = preferredPort + 1;
  await app.listen(fallbackPort, host);
  logger.warn(
    `Port ${preferredPort} is in use. API started on http://localhost:${fallbackPort}`,
  );
}
void bootstrap();
