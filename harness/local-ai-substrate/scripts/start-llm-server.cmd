@echo off

start "" /B "E:\llama-cpp-cuda\llama-server.exe" -m "E:\models\Qwen3.8-35B-A3B-Q4_K_M.gguf" --alias "qwen3.8-35b-a3b" --host 0.0.0.0 --port 8081 -ngl 99 -ncmoe 39 -fa on -ctk q8_0 -ctv q8_0 -c 49152 -np 1 -t 4 -tb 8 -b 2048 -ub 512 --load-mode none --cache-ram 8192 --spec-type draft-mtp --spec-draft-n-max 4 -ngld 99 --prio 2 --poll 100 --reasoning off --metrics

