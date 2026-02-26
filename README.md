# 🌍 Travel Advisor Backend

Hệ thống backend microservices cho ứng dụng đề xuất du lịch cá nhân hóa sử dụng AI.

## 📋 Tổng quan dự án

Travel Advisor Backend là một hệ thống microservices bao gồm:

- **API Gateway (NestJS)**: RESTful API gateway xử lý authentication, authorization, và routing
- **AI Service (Python/FastAPI)**: Service AI cung cấp các đề xuất du lịch cá nhân hóa sử dụng machine learning
- **PostgreSQL Database**: Cơ sở dữ liệu quan hệ lưu trữ thông tin người dùng, địa điểm, và lịch sử tương tác

## 🏗️ Kiến trúc hệ thống

```
travel-advisor-backend/
├── api-service/           # NestJS API Gateway
│   ├── src/
│   │   ├── app.controller.ts
│   │   ├── app.module.ts
│   │   ├── app.service.ts
│   │   └── main.ts
│   ├── package.json
│   └── tsconfig.json
│
├── ai-service/            # Python AI Service
│   ├── venv/              # Virtual environment (not tracked in git)
│   ├── main.py            # FastAPI application
│   └── requirements.txt   # Python dependencies
│
├── docker-compose.yml     # Docker Compose configuration
├── .env.example           # Environment variables template
├── .gitignore
└── README.md
```

## 🛠️ Công nghệ sử dụng

### Backend Services
- **NestJS** (v10.x): Progressive Node.js framework
- **Python** (3.11+): AI/ML service
- **FastAPI**: Modern Python web framework
- **TypeORM/Prisma**: ORM for NestJS
- **SQLAlchemy**: ORM for Python

### Database
- **PostgreSQL** (15): Primary database

### DevOps
- **Docker & Docker Compose**: Containerization
- **Git**: Version control

### AI/ML Libraries
- **NumPy**: Numerical computing
- **Pandas**: Data manipulation
- **Scikit-learn**: Machine learning

## 📦 Yêu cầu hệ thống

Trước khi bắt đầu, đảm bảo bạn đã cài đặt:

- **Node.js** (v18.x trở lên) và **npm**
- **Python** (v3.11 trở lên) và **pip**
- **Docker** và **Docker Compose**
- **Git**

Kiểm tra phiên bản:

```bash
node --version   # v18.x+
npm --version    # 9.x+
python --version # 3.11+
docker --version
docker-compose --version
```

## 🚀 Hướng dẫn cài đặt

### 1. Clone repository

```bash
git clone <your-repository-url>
cd travel-advisor-backend
```

### 2. Cấu hình môi trường

Sao chép file `.env.example` thành `.env`:

```bash
# Windows PowerShell
Copy-Item .env.example .env

# macOS/Linux
cp .env.example .env
```

Chỉnh sửa file `.env` với các giá trị thực tế của bạn.

### 3. Khởi động PostgreSQL Database

Sử dụng Docker Compose để khởi động database:

```bash
docker-compose up -d
```

Kiểm tra database đã chạy:

```bash
docker-compose ps
```

Bạn có thể kết nối đến database qua:
- **Host**: localhost
- **Port**: 5432
- **Database**: travel_db
- **User**: admin
- **Password**: password123

### 4. Setup API Service (NestJS)

```bash
# Di chuyển vào thư mục api-service
cd api-service

# Cài đặt dependencies
npm install

# Chạy development server
npm run start:dev
```

API Gateway sẽ chạy tại: **http://localhost:3000**

### 5. Setup AI Service (Python)

Mở terminal mới:

```bash
# Di chuyển vào thư mục ai-service
cd ai-service

# Kích hoạt virtual environment
# Windows PowerShell:
.\venv\Scripts\Activate.ps1

# macOS/Linux:
source venv/bin/activate

# Cài đặt dependencies
pip install -r requirements.txt

# Chạy Python service
python main.py
```

AI Service sẽ chạy tại: **http://localhost:8000**

## 🎯 Chạy toàn bộ hệ thống

Để chạy tất cả các services, bạn cần 3 terminal:

**Terminal 1 - PostgreSQL Database:**
```bash
docker-compose up
```

**Terminal 2 - NestJS API Gateway:**
```bash
cd api-service
npm run start:dev
```

**Terminal 3 - Python AI Service:**
```bash
cd ai-service
# Kích hoạt venv trước
python main.py
```

## 📡 API Endpoints

### API Gateway (NestJS) - Port 3000

- `GET /` - Health check
- `GET /api/v1/...` - API endpoints (thêm sau)

### AI Service (FastAPI) - Port 8000

- `GET /` - Service health check
- `GET /health` - Detailed health check
- `POST /api/v1/recommendations` - Lấy đề xuất du lịch
- `GET /api/v1/status` - Service status
- `GET /docs` - Swagger API documentation (tự động)

### Swagger Documentation

FastAPI tự động tạo interactive API docs:
- **Swagger UI**: http://localhost:8000/docs
- **ReDoc**: http://localhost:8000/redoc

## 🧪 Testing

### Test NestJS API

```bash
cd api-service

# Unit tests
npm run test

# E2E tests
npm run test:e2e

# Test coverage
npm run test:cov
```

### Test Python AI Service

```bash
cd ai-service
# Kích hoạt venv
pytest  # Cài pytest nếu cần
```

## 🗄️ Database Management

### Kết nối đến PostgreSQL

```bash
# Sử dụng docker exec
docker exec -it travel-advisor-postgres psql -U admin -d travel_db
```

### Migrations (NestJS với TypeORM)

```bash
cd api-service

# Tạo migration
npm run migration:generate -- -n MigrationName

# Chạy migrations
npm run migration:run

# Revert migration
npm run migration:revert
```

### Dừng và xóa database

```bash
# Dừng containers
docker-compose down

# Dừng và xóa volumes (MẤT TOÀN BỘ DATA!)
docker-compose down -v
```

## 🔧 Development Workflow

### 1. Tạo branch mới cho feature

```bash
git checkout -b feature/your-feature-name
```

### 2. Thực hiện thay đổi và commit

```bash
git add .
git commit -m "feat: add your feature description"
```

### 3. Push và tạo Pull Request

```bash
git push origin feature/your-feature-name
```

### Commit Message Convention

Sử dụng [Conventional Commits](https://www.conventionalcommits.org/):

- `feat:` - Tính năng mới
- `fix:` - Sửa bug
- `docs:` - Thay đổi documentation
- `style:` - Format code, không thay đổi logic
- `refactor:` - Refactor code
- `test:` - Thêm tests
- `chore:` - Maintenance tasks

## 📚 Tài liệu bổ sung

- [NestJS Documentation](https://docs.nestjs.com/)
- [FastAPI Documentation](https://fastapi.tiangolo.com/)
- [PostgreSQL Documentation](https://www.postgresql.org/docs/)
- [Docker Documentation](https://docs.docker.com/)

## 🤝 Contributing

1. Fork repository
2. Tạo branch cho feature (`git checkout -b feature/AmazingFeature`)
3. Commit changes (`git commit -m 'feat: Add some AmazingFeature'`)
4. Push to branch (`git push origin feature/AmazingFeature`)
5. Tạo Pull Request

## 📝 License

[MIT License](LICENSE)

## 👥 Team

- **Developer**: [Your Name]
- **Project**: Đồ án tốt nghiệp (DATN)
- **Year**: 2026

## 🐛 Troubleshooting

### Database connection failed
- Kiểm tra Docker container đang chạy: `docker-compose ps`
- Kiểm tra port 5432 không bị chiếm: `netstat -an | findstr 5432` (Windows)

### Port already in use
- **3000 đã bị sử dụng**: Thay đổi `API_SERVICE_PORT` trong `.env`
- **8000 đã bị sử dụng**: Thay đổi `AI_SERVICE_PORT` trong `.env`

### Python venv activation failed
- Windows: Chạy `Set-ExecutionPolicy -ExecutionPolicy RemoteSigned -Scope CurrentUser`
- Hoặc sử dụng: `venv\Scripts\activate.bat` thay vì `.ps1`

### NestJS dependencies error
```bash
cd api-service
rm -rf node_modules package-lock.json
npm install
```

---

**Happy Coding! 🚀**
