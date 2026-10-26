#!/bin/bash
set -e

echo "==> Updating packages and installing basic tools..."
sudo apt-get update
sudo apt-get upgrade -y
sudo apt-get install -y curl wget git vim cron certbot

echo "==> Setting up the red production prompt for CURRENT and FUTURE users..."
PROMPT_SETTING='export PS1="\[\e[41;1;37m\][PRODUCTION] \u@\h:\w $ \[\e[0m\] "'

# 現在のユーザーに適用
if ! grep -q "\[PRODUCTION\]" ~/.bashrc; then
    echo "$PROMPT_SETTING" >> ~/.bashrc
fi

# 今後作成される新規ユーザーすべてに適用（ここがポイント！）
if ! grep -q "\[PRODUCTION\]" /etc/skel/.bashrc; then
    sudo sh -c "echo '$PROMPT_SETTING' >> /etc/skel/.bashrc"
fi

echo "==> Setting up MOTD (Login Message)..."
sudo tee /etc/motd << EOF
################################################################
#                                                              #
#         【 専修大学 生亀プロジェクト 本番サーバー 】         #
#                                                              #
#    1. ここは本番環境です。作業前にDiscordで報告すること。    #
#    2. 不明なコマンドは実行せず、必ず管理者に相談すること。   #
#    3. 操作ログはすべて記録されています。                     #
#                                                              #
################################################################
EOF

echo "==> Setting up sudo lecture (Responsibility message)..."
sudo tee /etc/sudo_lecture.txt << EOF
あなたはシステム管理者から通常の講習を受けたはずです。
これは通常、以下の3点に要約されます:
    #1) 他人のプライバシーを尊重すること。
    #2) タイプする前に考えること。
    #3) 大いなる力には大いなる責任が伴うこと

【警告：大いなる責任】
・あなたの操作ひとつで、チーム全員の努力が無に帰すことを忘れないでください。
EOF

if ! sudo grep -q "lecture_file" /etc/sudoers; then
    echo 'Defaults lecture=always' | sudo EDITOR='tee -a' visudo
    echo 'Defaults lecture_file="/etc/sudo_lecture.txt"' | sudo EDITOR='tee -a' visudo
fi

echo "==> Installing Docker..."
sudo install -m 0755 -d /etc/apt/keyrings
sudo curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
sudo chmod a+r /etc/apt/keyrings/docker.asc

sudo tee /etc/apt/sources.list.d/docker.sources <<EOF
Types: deb
URIs: https://download.docker.com/linux/ubuntu
Suites: $(. /etc/os-release && echo "${UBUNTU_CODENAME:-$VERSION_CODENAME}")
Components: stable
Architectures: $(dpkg --print-architecture)
Signed-By: /etc/apt/keyrings/docker.asc
EOF

sudo apt-get update
sudo apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin

echo "==> Adding current user to the docker group..."
sudo usermod -aG docker $USER

<< COMMENTOUT
echo "==> Creating 2GB swap space..."
if [ ! -f /swapfile ]; then
    sudo fallocate -l 2G /swapfile
    sudo chmod 600 /swapfile
    sudo mkswap /swapfile
    sudo swapon /swapfile
    echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab
    echo "Swap space created."
else
    echo "Swap space already exists."
fi
COMMENTOUT

echo "=================================================="
echo "Setup completed successfully!"
echo "Current and future users will now see the production warnings."
echo "Please exit and log back in to see the changes."
echo "=================================================="

sudo /sbin/reboot
