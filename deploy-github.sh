#!/bin/bash
# Скрипт для пуша на GitHub

# Читаем токен из файла
source .github_token

if [ -z "$GH_TOKEN" ] || [[ "$GH_TOKEN" == "ghp_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx" ]]; then
    echo "❌ Ошибка: Вставьте ваш токен в файл .github_token"
    echo "   Создать токен: https://github.com/settings/tokens/new"
    exit 1
fi

# Настраиваем remote с токеном
git remote set-url origin https://${GH_TOKEN}@github.com/angyedz/MetaMessenger.git

# Пушим
echo "📤 Пушим на GitHub..."
git push -u origin main

if [ $? -eq 0 ]; then
    echo "✅ Успешно запушено!"
    echo "🔗 https://github.com/angyedz/MetaMessenger"
else
    echo "❌ Ошибка пуша"
fi
