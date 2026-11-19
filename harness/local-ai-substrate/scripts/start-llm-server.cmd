@echo off
start "" /B "E:\llama-cpp-cuda\llama-server.exe" -m "E:\models\Qwen3-Coder-30B-A3B-Instruct-IQ4_XS.gguf" --alias "qwen3-coder-30b-a3b" --host 0.0.0.0 --port 8081 -ngl 99 -ncmoe 48 -fa on -ctk q8_0 -ctv q8_0 -c 49152 -np 1 -t 4 -tb 8 -b 2048 -ub 512 --load-mode none --cache-ram 2048 --metrics
