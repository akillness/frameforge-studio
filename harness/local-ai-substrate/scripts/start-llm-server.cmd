@echo off
start "" /B "E:\llama-cpp-cuda\llama-server.exe" -m "E:\models\Qwen3.8-35B-A3B-Q4_K_M.gguf" --alias "qwen3.8-35b-a3b" --host 0.0.0.0 --port 8081 -ngl 99 -ncmoe 38 -fa on -ctk q8_0 -ctv q8_0 -c 65536 -np 1 -t 4 -tb 8 -b 2048 -ub 512 --load-mode none --cache-ram 2048 --reasoning off --metrics
