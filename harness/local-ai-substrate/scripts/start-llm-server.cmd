@echo off
start "" /B "E:\llama-cpp-cuda\llama-server.exe" -m "E:\models\Qwen3.8-9B-Q4_K_M.gguf" --alias "qwen3.8-9b" --host 0.0.0.0 --port 8081 -ngl 99 -fa on -ctk q8_0 -ctv q8_0 -c 32768 -np 1 -t 4 -tb 8 -b 2048 -ub 512 --load-mode none --cache-ram 8192 --spec-type ngram-mod --reasoning on --reasoning-budget 192 --metrics
