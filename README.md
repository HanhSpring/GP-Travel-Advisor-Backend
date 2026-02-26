# 🌍 Travel Advisor Backend

Backend microservices cho ứng dụng đề xuất du lịch sử dụng AI - bao gồm NestJS API Gateway, Python AI Service và PostgreSQL.

---

## 📦 Yêu cầu

- **Node.js** >= 18.x và npm
- **Python** >= 3.11 và pip  
- **Docker** và Docker Compose
- **Git**

Kiểm tra version:
```bash
node --version && npm --version
python --version
docker --version
```

---

## ⚡ Cài đặt lần đầu

### 1. Clone repository
```bash
git clone <repo-url>
cd travel-advisor-backend
```

### 2. Cấu hình môi trường
```bash
Copy-Item .env.example .env    # Copy file môi trường
# Mở .env và chỉnh sửa nếu cần (mặc định đã ok để dev)
```

### 3. Chạy Database
```bash
docker-compose up -d           # Start PostgreSQL
docker-compose ps              # Kiểm tra đang chạy
```

### 4. Setup API Service (NestJS)
```bash
cd api-service
npm install                    # Cài dependencies
npm run start:dev              # Chạy dev server
```
→ API chạy tại: **http://localhost:3000**

### 5. Setup AI Service (Python) 
*Mở terminal mới*
```bash
cd ai-service

# Tạo & kích hoạt virtual environment
python -m venv venv
.\venv\Scripts\Activate.ps1   # Windows PowerShell

# Cài dependencies
pip install -r requirements.txt

# Chạy service
python main.py
```
→ AI Service chạy tại: **http://localhost:8000**  
→ API Docs: **http://localhost:8000/docs**

---

## 🔄 Quy trình làm việc hằng ngày

```bash
# 1. Update code mới nhất
git checkout develop
git pull origin develop

# 2. Start database (nếu chưa chạy)
docker-compose up -d

# 3. Start NestJS (Terminal 1)
cd api-service
npm run start:dev

# 4. Start Python AI (Terminal 2)  
cd ai-service
.\venv\Scripts\Activate.ps1
python main.py
```

### Làm việc với Git

#### Bắt đầu feature/task mới
```bash
git checkout develop
git pull origin develop
git checkout -b feature/ten-feature    # hoặc fix/ten-bug
```

#### Commit thường xuyên
```bash
git status                             # Xem file thay đổi
git add .                              # Stage tất cả
git commit -m "feat: mô tả ngắn gọn"  # Commit với message chuẩn
```

**Convention commit messages:**
- `feat:` - Tính năng mới
- `fix:` - Sửa bug  
- `docs:` - Thay đổi docs
- `refactor:` - Refactor code
- `test:` - Thêm tests
- `chore:` - Update dependencies, config

#### Push code lên remote
```bash
git push origin feature/ten-feature
```

#### Tạo Pull Request
1. Vào GitHub/GitLab
2. Tạo PR từ `feature/ten-feature` → `develop`
3. Điền mô tả, tag reviewer
4. Chờ review & merge

#### Sau khi merge
```bash
git checkout develop
git pull origin develop
git branch -d feature/ten-feature      # Xóa branch local
```

---

## 🛠️ Các lệnh hay dùng

### Git
```bash
git status                    # Xem trạng thái
git log --oneline            # Xem lịch sử commit
git stash                    # Cất changes tạm thời
git stash pop                # Lấy lại stashed changes
git diff                     # Xem thay đổi chưa commit
```

### Database
```bash
# Kết nối vào PostgreSQL
docker exec -it travel-advisor-postgres psql -U admin -d travel_db

# Trong psql:
\dt                          # List tables
\d table_name                # Describe table
\q                           # Quit
```

---

## 🧪 Testing & Debugging

### Test API endpoints
- **NestJS API**: http://localhost:3000
- **Python API Docs**: http://localhost:8000/docs (Swagger tự động)
- Hoặc dùng Thunder Client extension trong VSCode

### Debug NestJS với VSCode
Tạo `.vscode/launch.json`:
```json
{
 "type": "node",
  "request": "launch",
  "name": "Debug NestJS",
  "runtimeExecutable": "npm",
  "runtimeArgs": ["run", "start:debug"],
  "cwd": "${workspaceFolder}/api-service"
}
```
Script trong `package.json`: `"start:debug": "nest start --debug --watch"`

### Xem logs
```bash
# NestJS logs - hiện ngay trên terminal đang chạy

# Docker logs
docker-compose logs -f postgres
```

---

## 🔗 Thông tin Database

**Local Development:**
- Host: `localhost`
- Port: `5432`
- Database: `travel_db`
- User: `admin`
- Password: `password123`

**Connection strings:**
```bash
# NestJS
DATABASE_URL=postgresql://admin:password123@localhost:5432/travel_db

# Python  
PYTHON_DATABASE_URL=postgresql://admin:password123@localhost:5432/travel_db
```

---

**Happy Coding! 🚀**

*Last updated: February 2026*
