@echo off
start "" /B "E:\llama-cpp-cuda\llama-server.exe" -m "E:\models\Qwen3.5-9B-Q3_K_M.gguf" --alias "qwen3.5-9b" --host 0.0.0.0 --port 8081 -ngl 99 -fa on -ctk q4_0 -ctv q4_0 -c 65536 -np 1 -t 4 -tb 8 -b 512 -ub 256 --load-mode none --cache-ram 8192 --spec-type ngram-mod --reasoning on --reasoning-budget 192 --metrics
