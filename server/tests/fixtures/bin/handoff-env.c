#include <stdio.h>
#include <unistd.h>
extern char **environ;
int main(int argc, char **argv) {
  char cwd[65536];
  if (!getcwd(cwd, sizeof cwd)) return 1;
  printf("%s%c", cwd, 0);
  for (int i = 1; i < argc; i++) printf("%s%c", argv[i], 0);
  printf("ENV%c", 0);
  for (char **entry = environ; *entry; entry++) printf("%s%c", *entry, 0);
  return 0;
}
