FROM node:20-slim
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund
COPY ./
CMD ["sh", "-c", "FIREBASE_JSON=$(cat /app/firebase.json) node index.js"]
