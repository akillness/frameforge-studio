@echo off
start "" /B "E:\llama-cpp-cuda\llama-server.exe" -m "E:\models\qev-0.8b-text-Q8_0.gguf" --alias "labqoat/qev-0.8b-GGUF:text-Q8_0" --host 0.0.0.0 --port 8080 -ngl 99 -fa on -ctk q8_0 -ctv q8_0 -c 32768 -np 1 -t 4 -b 2048 -ub 512 --load-mode none --cache-ram 1024 --metrics
